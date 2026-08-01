import { Hono, type Context } from 'hono'

type Bindings = CloudflareBindings & {
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
}
type AppEnv = { Bindings: Bindings }

const app = new Hono<AppEnv>()
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ADMIN_USERNAME = 'admin'
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_FAILURES = 5
const MAX_JSON_BYTES = 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])

type AdminTokenPayload = { sub: 'admin'; iat: number; exp: number; nonce: string }
type LoginAttempt = { count: number; windowStart: number }
type SheetData = {
  members: Array<{ id: string; name?: string; phone?: string }>;
  dates: Array<{ id: string; iso?: string }>;
  cells?: Record<string, unknown>;
  labels?: unknown;
  [key: string]: unknown;
}

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "default-src 'self'; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
})

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

async function constantTimeTextEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)])
  return equalBytes(leftDigest, rightDigest)
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

async function issueAdminToken(secret: string): Promise<{ token: string; expiresAt: number }> {
  const now = Date.now()
  const payload: AdminTokenPayload = { sub: 'admin', iat: now, exp: now + ADMIN_SESSION_MS, nonce: crypto.randomUUID() }
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)))
  const signature = bytesToBase64Url(await hmac(secret, body))
  return { token: `${body}.${signature}`, expiresAt: payload.exp }
}

async function verifyAdminRequest(c: Context<AppEnv>): Promise<boolean> {
  const authorization = c.req.header('authorization') || ''
  if (!authorization.startsWith('Bearer ') || !c.env.SESSION_SECRET) return false
  const parts = authorization.slice(7).split('.')
  if (parts.length !== 2) return false
  try {
    const supplied = base64UrlToBytes(parts[1])
    const expected = await hmac(c.env.SESSION_SECRET, parts[0])
    if (!equalBytes(supplied, expected)) return false
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(parts[0]))) as AdminTokenPayload
    return payload.sub === 'admin' && Number.isFinite(payload.exp) && payload.exp > Date.now()
  } catch {
    return false
  }
}

function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store')
}

async function loginAttemptKey(c: Context<AppEnv>): Promise<string> {
  const ip = c.req.header('cf-connecting-ip') || 'local'
  const hash = await digest(ip)
  return `auth/login/${bytesToBase64Url(hash.slice(0, 18))}.json`
}

async function readLoginAttempt(c: Context<AppEnv>, key: string): Promise<LoginAttempt> {
  const object = await c.env.ASSETS_BUCKET.get(key)
  if (!object) return { count: 0, windowStart: Date.now() }
  try {
    const parsed = JSON.parse(await object.text()) as LoginAttempt
    if (!Number.isFinite(parsed.count) || !Number.isFinite(parsed.windowStart) || Date.now() - parsed.windowStart > LOGIN_WINDOW_MS) {
      return { count: 0, windowStart: Date.now() }
    }
    return parsed
  } catch {
    return { count: 0, windowStart: Date.now() }
  }
}

async function recordLoginFailure(c: Context<AppEnv>, key: string, previous: LoginAttempt): Promise<void> {
  const next: LoginAttempt = { count: previous.count + 1, windowStart: previous.windowStart }
  await c.env.ASSETS_BUCKET.put(key, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' } })
}

function hasBoundedJsonBody(c: Context<AppEnv>, maximum = MAX_JSON_BYTES): boolean {
  const contentLength = Number(c.req.header('content-length'))
  return Number.isFinite(contentLength) && contentLength > 0 && contentLength <= maximum
}

function isSheetData(value: unknown): value is SheetData {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<SheetData>
  if (!Array.isArray(data.members) || !Array.isArray(data.dates)) return false
  if (data.members.length > 200 || data.dates.length > 500) return false
  if (!data.members.every((member) => member && typeof member.id === 'string' && member.id.length <= 100)) return false
  if (!data.dates.every((date) => date && typeof date.id === 'string' && date.id.length <= 100)) return false
  if (data.cells && (typeof data.cells !== 'object' || Object.keys(data.cells).length > 100000)) return false
  return true
}

function requiresAdminForSheetChange(current: SheetData | null, next: SheetData): boolean {
  if (!current) return false
  const nextMemberIds = new Set(next.members.map((member) => member.id))
  const nextDateIds = new Set(next.dates.map((date) => date.id))
  if (current.members.some((member) => !nextMemberIds.has(member.id))) return true
  if (current.dates.some((date) => !nextDateIds.has(date.id))) return true
  return JSON.stringify(current.labels ?? null) !== JSON.stringify(next.labels ?? null)
}

app.post('/api/admin/login', async (c) => {
  noStore(c)
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ ok: false, error: 'admin login is not configured' }, 503)
  }
  if (!hasBoundedJsonBody(c, 4096)) return c.json({ ok: false, error: 'bad request' }, 400)

  const key = await loginAttemptKey(c)
  const attempt = await readLoginAttempt(c, key)
  if (attempt.count >= MAX_LOGIN_FAILURES) {
    const retryAfter = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - attempt.windowStart)) / 1000))
    c.header('Retry-After', String(retryAfter))
    return c.json({ ok: false, error: 'too many attempts', retryAfter }, 429)
  }

  const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => null)
  const username = typeof body?.username === 'string' ? body.username : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const [validUsername, validPassword] = await Promise.all([
    constantTimeTextEqual(username, ADMIN_USERNAME),
    constantTimeTextEqual(password, c.env.ADMIN_PASSWORD)
  ])
  if (!validUsername || !validPassword) {
    await recordLoginFailure(c, key, attempt)
    return c.json({ ok: false, error: 'invalid credentials' }, 401)
  }

  await c.env.ASSETS_BUCKET.delete(key)
  const session = await issueAdminToken(c.env.SESSION_SECRET)
  return c.json({ ok: true, token: session.token, expiresAt: session.expiresAt })
})

// ---------- 자료실 API (Cloudflare R2) ----------

// 목록: R2에 저장된 이미지들의 메타데이터(id, name, ts) 반환
app.get('/api/assets', async (c) => {
  try {
    const list = await c.env.ASSETS_BUCKET.list({ prefix: 'assets/', include: ['customMetadata'] });
    const items = list.objects.map((o) => {
      const meta = (o.customMetadata || {}) as Record<string, string>;
      const id = o.key.replace(/^assets\//, '');
      return {
        id,
        name: meta.name || id,
        ts: meta.ts ? Number(meta.ts) : (o.uploaded ? new Date(o.uploaded).getTime() : 0),
        url: '/api/assets/' + encodeURIComponent(id)
      };
    });
    // 최신 업로드가 위로
    items.sort((a, b) => b.ts - a.ts);
    return c.json({ ok: true, assets: items });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e && e.message || e) }, 500);
  }
});

// 이미지 원본 조회 (누구나 볼 수 있음 = 공유)
app.get('/api/assets/:id', async (c) => {
  const id = c.req.param('id');
  const obj = await c.env.ASSETS_BUCKET.get('assets/' + id);
  if (!obj) return c.notFound();
  const headers = new Headers();
  const storedType = (obj.httpMetadata && obj.httpMetadata.contentType) || '';
  const ct = ALLOWED_IMAGE_TYPES.has(storedType) ? storedType : 'application/octet-stream';
  headers.set('Content-Type', ct);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (ct === 'application/octet-stream') headers.set('Content-Disposition', 'attachment');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

// 업로드 (관리자만): multipart/form-data { file, name }
app.post('/api/assets', async (c) => {
  if (!(await verifyAdminRequest(c))) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!hasBoundedJsonBody(c, 9 * 1024 * 1024)) return c.json({ ok: false, error: 'bad request' }, 400);
  try {
    const form = await c.req.formData();
    const file = form.get('file');
    const name = (form.get('name') as string) || '';
    if (!file || typeof file === 'string') return c.json({ ok: false, error: 'no file' }, 400);
    const f = file as unknown as File;
    if (f.size > 8 * 1024 * 1024) return c.json({ ok: false, error: 'too large (max 8MB)' }, 400);
    if (!ALLOWED_IMAGE_TYPES.has(f.type)) return c.json({ ok: false, error: 'unsupported image type' }, 415);

    const extensionMatch = f.name.toLowerCase().match(/\.(jpe?g|png|gif|webp|avif)$/);
    const ext = extensionMatch ? extensionMatch[0] : '';
    const id = crypto.randomUUID() + ext;
    const buf = await f.arrayBuffer();
    await c.env.ASSETS_BUCKET.put('assets/' + id, buf, {
      httpMetadata: { contentType: f.type || 'application/octet-stream' },
      customMetadata: { name: (name || f.name || '자료'), ts: String(Date.now()) }
    });
    return c.json({ ok: true, asset: { id, name: (name || f.name || '자료'), ts: Date.now(), url: '/api/assets/' + encodeURIComponent(id) } });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e && e.message || e) }, 500);
  }
});

// 이름 수정 (관리자만): { name }
app.patch('/api/assets/:id', async (c) => {
  if (!(await verifyAdminRequest(c))) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!hasBoundedJsonBody(c, 4096)) return c.json({ ok: false, error: 'bad request' }, 400);
  try {
    const id = c.req.param('id');
    const key = 'assets/' + id;
    const obj = await c.env.ASSETS_BUCKET.get(key);
    if (!obj) return c.json({ ok: false, error: 'not found' }, 404);
    const body: { name?: unknown } = await c.req.json<{ name?: unknown }>().catch(() => ({}));
    const newName = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    if (!newName) return c.json({ ok: false, error: 'no name' }, 400);
    const prevMeta = (obj.customMetadata || {}) as Record<string, string>;
    const buf = await obj.arrayBuffer();
    await c.env.ASSETS_BUCKET.put(key, buf, {
      httpMetadata: obj.httpMetadata,
      customMetadata: { name: newName, ts: prevMeta.ts || String(Date.now()) }
    });
    return c.json({ ok: true, asset: { id, name: newName } });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e && e.message || e) }, 500);
  }
});

// 삭제 (관리자만)
app.delete('/api/assets/:id', async (c) => {
  if (!(await verifyAdminRequest(c))) return c.json({ ok: false, error: 'unauthorized' }, 401);
  try {
    await c.env.ASSETS_BUCKET.delete('assets/' + c.req.param('id'));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e && e.message || e) }, 500);
  }
});

// ---------- 정산표 데이터 공유 API (Cloudflare R2에 JSON 저장) ----------
// 모든 기기(모바일/PC)가 같은 정산표 데이터를 실시간 공유하도록 서버에 저장한다.
// localStorage는 기기별로 분리돼 있어 연동이 안 되므로, 여기 서버 저장본을 "정본"으로 쓴다.
const SHEET_KEY = 'sheet/data.json';

// 서버에 저장된 정산표 데이터 조회. 없으면 rev=0 + null 데이터 반환.
app.get('/api/sheet', async (c) => {
  try {
    const obj = await c.env.ASSETS_BUCKET.get(SHEET_KEY);
    if (!obj) return c.json({ ok: true, rev: 0, data: null });
    const text = await obj.text();
    let parsed: unknown = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    const meta = (obj.customMetadata || {}) as Record<string, string>;
    const rev = meta.rev ? Number(meta.rev) : 0;
    return c.json({ ok: true, rev, data: parsed });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e && e.message || e) }, 500);
  }
});

// 정산표 데이터 저장. 일반 사용자도 입력·수정하므로 인증 없이 허용한다.
// body: { data: {...}, baseRev: number }  → 저장 성공 시 새 rev 반환.
// baseRev 가 서버 현재 rev 와 다르면 409(충돌) 반환 → 클라이언트가 먼저 최신을 받아 병합.
app.put('/api/sheet', async (c) => {
  try {
    if (!hasBoundedJsonBody(c)) return c.json({ ok: false, error: 'bad request' }, 400);
    const body = await c.req.json<{ data?: unknown; baseRev?: unknown }>().catch(() => null);
    if (!body || !isSheetData(body.data)) {
      return c.json({ ok: false, error: 'bad request' }, 400);
    }
    // 현재 서버 rev 확인
    let curRev = 0;
    const cur = await c.env.ASSETS_BUCKET.get(SHEET_KEY);
    if (cur) {
      const m = (cur.customMetadata || {}) as Record<string, string>;
      curRev = m.rev ? Number(m.rev) : 0;
    }
    // 낙관적 동시성: baseRev 가 제시됐고 서버 rev 와 다르면 충돌
    if (typeof body.baseRev === 'number' && body.baseRev !== curRev) {
      // 최신 서버 데이터를 함께 돌려줘서 클라이언트가 병합하게 함
      let latest: unknown = null;
      if (cur) { const t = await cur.text(); if (t) { try { latest = JSON.parse(t); } catch {} } }
      return c.json({ ok: false, conflict: true, rev: curRev, data: latest }, 409);
    }
    let currentData: SheetData | null = null;
    if (cur) {
      try {
        const parsed = JSON.parse(await cur.text()) as unknown;
        if (isSheetData(parsed)) currentData = parsed;
      } catch {}
    }
    if (requiresAdminForSheetChange(currentData, body.data) && !(await verifyAdminRequest(c))) {
      return c.json({ ok: false, error: 'admin authorization required' }, 403);
    }
    const newRev = curRev + 1;
    const payload = JSON.stringify(body.data);
    await c.env.ASSETS_BUCKET.put(SHEET_KEY, payload, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { rev: String(newRev), ts: String(Date.now()) }
    });
    return c.json({ ok: true, rev: newRev });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e && e.message || e) }, 500);
  }
});

app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <meta name="theme-color" content="#1f7a4d">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⛳</text></svg>">
  <title>사보회</title>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="/static/style.css?v=20260730w" rel="stylesheet">
</head>
<body>
  <header class="app-header" id="app-header">
    <div class="app-header-inner" id="app-header-inner">
      <h1><i class="fas fa-golf-ball-tee"></i> 사보회</h1>
      <div class="header-actions">
        <button id="btn-add-member" class="btn btn-light"><i class="fas fa-user-plus"></i><span class="btn-text"> 회원추가</span></button>
        <button id="btn-add-date" class="btn btn-light"><i class="fas fa-calendar-plus"></i><span class="btn-text"> 날짜추가</span></button>
        <input type="date" id="date-picker" class="date-picker-hidden" aria-label="골프 친 날짜 선택" />
        <button id="btn-export" class="btn btn-light"><i class="fas fa-file-csv"></i><span class="btn-text"> 엑셀저장</span></button>
        <button id="btn-clear" class="btn btn-light"><i class="fas fa-up-right-and-down-left-from-center"></i><span class="btn-text btn-text-sm"> 날짜펼치기</span></button>
        <button id="btn-admin" class="btn btn-gold"><i class="fas fa-user-shield"></i><span class="btn-text"> 관리자</span></button>
      </div>
    </div>
  </header>

  <main class="app-main" id="view-sheet">
    <div id="mode-banner" class="mode-banner mode-user">
      <i class="fas fa-pen"></i><span class="mode-banner-text">일반 사용자 모드 · 모든 칸을 <b>자유롭게 입력·수정</b>할 수 있습니다 (회원·날짜 삭제, 자료실은 관리자)</span>
    </div>
    <div class="table-wrap" id="table-wrap">
      <table id="sheet" class="sheet">
        <thead id="sheet-head"></thead>
        <tbody id="sheet-body"></tbody>
        <tfoot id="sheet-foot"></tfoot>
      </table>
    </div>
  </main>

  <!-- 관리자 자료실 화면 -->
  <main class="app-main hidden" id="view-admin">
    <section class="admin-panel">
      <div class="admin-top">
        <h2><i class="fas fa-database"></i> 관리자 자료실</h2>
        <div class="admin-top-btns">
          <button id="btn-admin-close" class="btn btn-gray"><i class="fas fa-table"></i> 정산표로</button>
          <button id="btn-logout" class="btn btn-red"><i class="fas fa-right-from-bracket"></i> 로그아웃</button>
        </div>
      </div>
      <p class="admin-note"><i class="fas fa-circle-info"></i> 관리자 모드에서는 정산표의 모든 값을 <b>수정·삭제</b>할 수 있습니다. 로그아웃하면 일반 사용자는 <b>새 입력만</b> 가능합니다.</p>

      <div class="admin-cards">
        <div class="admin-card">
          <h3><i class="fas fa-chart-simple"></i> 데이터 요약</h3>
          <div id="admin-summary" class="admin-summary"></div>
          <div class="admin-btns">
            <button id="admin-export" class="btn btn-green"><i class="fas fa-file-csv"></i> 정산표 CSV 내보내기</button>
            <button id="admin-backup" class="btn btn-green"><i class="fas fa-download"></i> 전체 백업(JSON)</button>
            <label class="btn btn-gray file-btn"><i class="fas fa-upload"></i> 백업 복원
              <input id="admin-restore" type="file" accept="application/json" hidden />
            </label>
            <button id="admin-reset" class="btn btn-red"><i class="fas fa-trash-can"></i> 정산표 완전 초기화</button>
          </div>
        </div>

        <div class="admin-card">
          <h3><i class="fas fa-pen-to-square"></i> 화면 문구 수정</h3>
          <p class="admin-desc"><i class="fas fa-circle-info"></i> 앱 화면에 보이는 <b>제목과 항목 이름</b>을 직접 바꿀 수 있습니다. 저장하면 모든 화면에 바로 반영됩니다.</p>
          <div class="label-edit">
            <label class="lbl-row"><span>상단 제목</span><input id="lbl-title" type="text" maxlength="24" placeholder="사보회" /></label>
            <label class="lbl-row"><span>날짜칸 의미</span><input id="lbl-lost" type="text" maxlength="12" placeholder="타수" /></label>
            <label class="lbl-row"><span>이름 열 제목</span><input id="lbl-name" type="text" maxlength="12" placeholder="회원 이름" /></label>
            <label class="lbl-row"><span>번호 열 제목</span><input id="lbl-phone" type="text" maxlength="12" placeholder="양지번호" /></label>

          </div>
          <div class="admin-btns">
            <button id="lbl-save" class="btn btn-green"><i class="fas fa-check"></i> 문구 저장</button>
            <button id="lbl-reset" class="btn btn-gray"><i class="fas fa-rotate-left"></i> 기본값으로</button>
          </div>
        </div>

        <div class="admin-card">
          <h3><i class="fas fa-calendar-days"></i> 날짜 관리 (타수 비우기 · 날짜 삭제)</h3>
          <p class="admin-desc"><i class="fas fa-circle-info"></i> 등록된 <b>모든 날짜</b> 목록입니다. 날짜별로 <b>그날 타수를 전부 비우거나</b>, <b>날짜 열 자체를 삭제</b>할 수 있습니다. 삭제한 타수는 되돌릴 수 없습니다.</p>
          <div id="admin-date-list" class="date-manage-list"></div>
        </div>

        <div class="admin-card">
          <h3><i class="fas fa-images"></i> 자료실 (이미지 · 이름)</h3>
          <p class="admin-desc"><i class="fas fa-cloud"></i> 이미지는 <b>서버(Cloudflare R2)</b>에 저장되어 <b>모든 사람이 함께 보고</b>, 자동으로 <b>영구 보관·백업</b>됩니다. 브라우저를 지워도 사라지지 않습니다. (이미지당 최대 8MB)</p>
          <div class="asset-add">
            <input id="asset-name" type="text" placeholder="자료 이름 (예: 김회원 사진)" />
            <label class="btn btn-green file-btn"><i class="fas fa-image"></i> 이미지 선택
              <input id="asset-file" type="file" accept="image/*" hidden />
            </label>
            <button id="asset-save" class="btn btn-gold"><i class="fas fa-plus"></i> 등록</button>
          </div>
          <div id="asset-list" class="asset-list"></div>
        </div>
      </div>
    </section>
  </main>

  <!-- 관리자 로그인 모달 -->
  <div id="login-modal" class="modal hidden">
    <div class="modal-box">
      <h3><i class="fas fa-user-shield"></i> 관리자 로그인</h3>
      <label>아이디
        <input id="login-id" type="text" placeholder="admin" autocomplete="username" />
      </label>
      <label>비밀번호
        <input id="login-pw" type="password" placeholder="비밀번호" autocomplete="current-password" />
      </label>
      <p id="login-error" class="login-error hidden">아이디 또는 비밀번호가 올바르지 않습니다.</p>
      <div class="modal-actions">
        <button id="login-cancel" class="btn btn-gray">취소</button>
        <button id="login-ok" class="btn btn-green">로그인</button>
      </div>
    </div>
  </div>

  <!-- 타수 빠른입력 팝오버 -->
  <div id="quick-pad" class="quick-pad hidden">
    <div class="quick-pad-cur"><span id="quick-cur">0</span> 타</div>
    <div class="quick-pad-btns">
      <button class="qp-btn qp-add" data-add="1">+1</button>
      <button class="qp-btn qp-add" data-add="2">+2</button>
      <button class="qp-btn qp-add" data-add="3">+3</button>
      <button class="qp-btn qp-add" data-add="5">+5</button>
      <button class="qp-btn qp-add" data-add="10">+10</button>
      <button class="qp-btn qp-clear" data-clear="1"><i class="fas fa-eraser"></i> 지움</button>
    </div>
    <div class="quick-pad-foot">
      <button class="qp-done"><i class="fas fa-check"></i> 완료</button>
    </div>
  </div>

  <!-- 이미지 크게 보기 -->
  <div id="img-modal" class="modal hidden">
    <div class="img-view">
      <button id="img-close" class="img-close"><i class="fas fa-xmark"></i></button>
      <img id="img-big" src="" alt="" />
      <div id="img-caption" class="img-caption"></div>
    </div>
  </div>

  <script src="/static/app.js?v=20260730w"></script>
</body>
</html>`)
})

export default app
