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
const SCORE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])

type AdminTokenPayload = { sub: 'admin'; iat: number; exp: number; nonce: string }
type LoginAttempt = { count: number; windowStart: number }
type AppStateRow = { rev: number; data_json: string | null }
type SheetData = {
  members: Array<{ id: string; name?: string; [key: string]: unknown }>;
  dates: Array<{ id: string; iso?: string }>;
  cells?: Record<string, unknown>;
  editTimes?: unknown;
  labels?: unknown;
  [key: string]: unknown;
}

// 이전 버전이 전송한 번호 필드도 저장하거나 다시 노출하지 않는다.
// 그 밖의 알 수 없는 필드는 그대로 복사해 백업/복원 호환성을 유지한다.
function stripStoredNumberData(data: SheetData): SheetData {
  const cleaned: SheetData = {
    ...data,
    members: data.members.map((member) => {
      const copy = { ...member }
      delete copy.phone
      return copy
    })
  }
  if (cleaned.manager && typeof cleaned.manager === 'object' && !Array.isArray(cleaned.manager)) {
    const manager = { ...(cleaned.manager as Record<string, unknown>) }
    delete manager.phone
    cleaned.manager = manager
  }
  if (cleaned.labels && typeof cleaned.labels === 'object' && !Array.isArray(cleaned.labels)) {
    const labels = { ...(cleaned.labels as Record<string, unknown>) }
    delete labels.colPhone
    cleaned.labels = labels
  }
  return cleaned
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logError(message: string, error: unknown, path?: string): void {
  console.error(JSON.stringify({ message, error: errorMessage(error), path }))
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
  return bytesToBase64Url(hash.slice(0, 18))
}

async function readLoginAttempt(c: Context<AppEnv>, key: string): Promise<LoginAttempt> {
  const row = await c.env.DB.prepare(
    'SELECT failure_count, window_start FROM login_attempts WHERE ip_hash = ?'
  ).bind(key).first<{ failure_count: number; window_start: number }>()
  if (!row) return { count: 0, windowStart: Date.now() }
  if (Date.now() - row.window_start > LOGIN_WINDOW_MS) {
    await c.env.DB.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').bind(key).run()
    return { count: 0, windowStart: Date.now() }
  }
  return { count: row.failure_count, windowStart: row.window_start }
}

async function recordLoginFailure(c: Context<AppEnv>, key: string, previous: LoginAttempt): Promise<void> {
  const next: LoginAttempt = { count: previous.count + 1, windowStart: previous.windowStart }
  await c.env.DB.prepare(
    `INSERT INTO login_attempts (ip_hash, failure_count, window_start) VALUES (?, ?, ?)
     ON CONFLICT(ip_hash) DO UPDATE SET failure_count = excluded.failure_count, window_start = excluded.window_start`
  ).bind(key, next.count, next.windowStart).run()
}

async function recordAdminAudit(
  c: Context<AppEnv>,
  action: string,
  targetType: string,
  targetId: string | null,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await c.env.DB.prepare(
      'INSERT INTO admin_audit (action, target_type, target_id, details_json) VALUES (?, ?, ?, ?)'
    ).bind(action, targetType, targetId, details ? JSON.stringify(details) : null).run()
  } catch (error) {
    logError('admin audit write failed', error, c.req.path)
  }
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
  const memberIds = new Set(data.members.map((member) => member.id))
  const dateIds = new Set(data.dates.map((date) => date.id))
  if (memberIds.size !== data.members.length || dateIds.size !== data.dates.length) return false
  if (!data.members.every((member) =>
    member.name === undefined || (typeof member.name === 'string' && member.name.length <= 24)
  )) return false
  if (!data.dates.every((date) => date.iso === undefined || (typeof date.iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.iso)))) return false
  if (data.cells) {
    if (typeof data.cells !== 'object' || Array.isArray(data.cells) || Object.keys(data.cells).length > 100000) return false
    for (const [key, score] of Object.entries(data.cells)) {
      const separator = key.indexOf('|')
      if (separator <= 0 || key.indexOf('|', separator + 1) !== -1) return false
      if (!memberIds.has(key.slice(0, separator)) || !dateIds.has(key.slice(separator + 1))) return false
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 999) return false
    }
  }
  if (data.editTimes !== undefined) {
    if (!data.editTimes || typeof data.editTimes !== 'object' || Array.isArray(data.editTimes)) return false
    const editRoot = data.editTimes as Record<string, unknown>
    const validateTimes = (times: unknown): boolean => {
      if (times === undefined) return true
      if (!times || typeof times !== 'object' || Array.isArray(times) || Object.keys(times).length > 100000) return false
      return Object.values(times as Record<string, unknown>).every((editedAt) =>
        typeof editedAt === 'number' && Number.isFinite(editedAt) && editedAt >= 0
      )
    }
    const isNested = Object.prototype.hasOwnProperty.call(editRoot, 'cells') ||
      Object.prototype.hasOwnProperty.call(editRoot, 'names') ||
      Object.prototype.hasOwnProperty.call(editRoot, 'expenses')
    if (isNested) {
      if (!validateTimes(editRoot.cells) || !validateTimes(editRoot.names) || !validateTimes(editRoot.expenses)) return false
    } else if (!validateTimes(editRoot)) return false
  }
  return true
}

function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function removesNestedValue(current: unknown, next: unknown): boolean {
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const before = current as Record<string, unknown>
    const after = next && typeof next === 'object' && !Array.isArray(next) ? next as Record<string, unknown> : {}
    return Object.keys(before).some((key) => removesNestedValue(before[key], after[key]))
  }
  return isMeaningfulValue(current) && !isMeaningfulValue(next)
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cellEditTimes(value: unknown): Record<string, unknown> {
  const root = recordValue(value)
  const isNested = Object.prototype.hasOwnProperty.call(root, 'cells') ||
    Object.prototype.hasOwnProperty.call(root, 'names') ||
    Object.prototype.hasOwnProperty.call(root, 'expenses')
  return isNested ? recordValue(root.cells) : root
}

function expenseEditTimes(value: unknown): Record<string, unknown> {
  return recordValue(recordValue(value).expenses)
}

function effectiveExpenses(value: SheetData | null): Record<string, unknown> {
  const extra = recordValue(value?.extra)
  const result = { ...recordValue(extra.expenses) }
  const latest = value?.dates.slice().sort((left, right) => (right.iso || '').localeCompare(left.iso || ''))[0]
  if (latest && !isMeaningfulValue(result[latest.id]) && isMeaningfulValue(extra.legacyExpense)) {
    result[latest.id] = extra.legacyExpense
  }
  return result
}

function changesExpiredScore(current: SheetData, next: SheetData, now = Date.now()): boolean {
  const currentCells = recordValue(current.cells)
  const nextCells = recordValue(next.cells)
  const editTimes = cellEditTimes(current.editTimes)
  return Object.keys(currentCells).some((key) => {
    if (!isMeaningfulValue(currentCells[key]) || currentCells[key] === nextCells[key]) return false
    const editedAt = Number(editTimes[key])
    return !Number.isFinite(editedAt) || editedAt <= 0 || now - editedAt >= SCORE_EDIT_WINDOW_MS
  })
}

function changesExpiredExpense(current: SheetData, next: SheetData, now = Date.now()): boolean {
  const currentExpenses = effectiveExpenses(current)
  const nextExpenses = effectiveExpenses(next)
  const editTimes = expenseEditTimes(current.editTimes)
  const keys = new Set([...Object.keys(currentExpenses), ...Object.keys(nextExpenses)])
  return [...keys].some((dateId) => {
    if (currentExpenses[dateId] === nextExpenses[dateId]) return false
    if (!isMeaningfulValue(currentExpenses[dateId])) return false
    const editedAt = Number(editTimes[dateId])
    return !Number.isFinite(editedAt) || editedAt <= 0 || now - editedAt >= SCORE_EDIT_WINDOW_MS
  })
}

function changesAdminOnlyExtra(current: SheetData, next: SheetData): boolean {
  const before = { ...recordValue(current.extra) }
  const after = { ...recordValue(next.extra) }
  delete before.expenses
  delete after.expenses
  delete before.legacyExpense
  delete after.legacyExpense
  return JSON.stringify(before) !== JSON.stringify(after)
}

function stampCellEditTimes(current: SheetData | null, next: SheetData, now = Date.now()): SheetData {
  const currentCells = recordValue(current?.cells)
  const nextCells = recordValue(next.cells)
  const currentEditRoot = recordValue(current?.editTimes)
  const nextEditRoot = recordValue(next.editTimes)
  const usesNestedTimes = Object.prototype.hasOwnProperty.call(currentEditRoot, 'cells') ||
    Object.prototype.hasOwnProperty.call(currentEditRoot, 'names') ||
    Object.prototype.hasOwnProperty.call(currentEditRoot, 'expenses') ||
    Object.prototype.hasOwnProperty.call(nextEditRoot, 'cells') ||
    Object.prototype.hasOwnProperty.call(nextEditRoot, 'names') ||
    Object.prototype.hasOwnProperty.call(nextEditRoot, 'expenses')
  const currentTimes = usesNestedTimes ? recordValue(currentEditRoot.cells) : currentEditRoot
  const stampedTimes = { ...(usesNestedTimes ? recordValue(nextEditRoot.cells) : nextEditRoot) }
  const keys = new Set([...Object.keys(currentCells), ...Object.keys(nextCells)])
  keys.forEach((key) => {
    if (!isMeaningfulValue(nextCells[key])) {
      delete stampedTimes[key]
      return
    }
    const previousTime = Number(currentTimes[key])
    if (isMeaningfulValue(currentCells[key])) {
      // 최초 입력 시각을 유지한다. 과거 데이터처럼 시각이 없으면 임의로 새 시각을 만들지 않아 계속 관리자만 수정한다.
      if (Number.isFinite(previousTime) && previousTime > 0) stampedTimes[key] = previousTime
      else delete stampedTimes[key]
    } else {
      stampedTimes[key] = now
    }
  })
  const currentExpenses = effectiveExpenses(current)
  const nextExpenses = effectiveExpenses(next)
  const currentExpenseTimes = expenseEditTimes(current?.editTimes)
  const stampedExpenseTimes = { ...recordValue(nextEditRoot.expenses) }
  const expenseKeys = new Set([...Object.keys(currentExpenses), ...Object.keys(nextExpenses)])
  expenseKeys.forEach((dateId) => {
    if (!isMeaningfulValue(nextExpenses[dateId])) {
      delete stampedExpenseTimes[dateId]
      return
    }
    const previousTime = Number(currentExpenseTimes[dateId])
    if (isMeaningfulValue(currentExpenses[dateId])) {
      // 기존 값의 최초 입력 시각을 유지한다. 시각이 없는 과거 값은 계속 관리자만 수정한다.
      if (Number.isFinite(previousTime) && previousTime > 0) stampedExpenseTimes[dateId] = previousTime
      else delete stampedExpenseTimes[dateId]
    } else {
      stampedExpenseTimes[dateId] = now
    }
  })
  const editTimes = { ...nextEditRoot, cells: stampedTimes, expenses: stampedExpenseTimes }
  return { ...next, editTimes }
}
function requiresAdminForSheetChange(current: SheetData | null, next: SheetData): boolean {
  if (!current) return false
  const nextMemberIds = new Set(next.members.map((member) => member.id))
  const nextDateIds = new Set(next.dates.map((date) => date.id))
  if (current.members.some((member) => !nextMemberIds.has(member.id))) return true
  if (current.dates.some((date) => !nextDateIds.has(date.id))) return true
  for (const member of current.members) {
    const nextMember = next.members.find((candidate) => candidate.id === member.id)
    if (!nextMember) return true
    if (isMeaningfulValue(member.name) && !isMeaningfulValue(nextMember.name)) return true
  }
  if (changesExpiredScore(current, next)) return true
  if (changesExpiredExpense(current, next)) return true
  // 총액과 알 수 없는 정산 필드는 관리자만 변경한다. 날짜별 지출은 최초 입력 후 24시간 동안 일반 사용자도 변경할 수 있다.
  if (changesAdminOnlyExtra(current, next)) return true
  if (removesNestedValue(current.manager, next.manager)) return true
  return JSON.stringify(current.labels ?? null) !== JSON.stringify(next.labels ?? null)
}

async function readD1Sheet(c: Context<AppEnv>): Promise<{ rev: number; data: SheetData | null }> {
  const row = await c.env.DB.prepare('SELECT rev, data_json FROM app_state WHERE id = 1').first<AppStateRow>()
  if (row?.data_json) {
    try {
      const parsed = JSON.parse(row.data_json) as unknown
      if (isSheetData(parsed)) return { rev: Number(row.rev) || 0, data: stripStoredNumberData(parsed) }
    } catch (error) {
      logError('D1 app state parse failed', error, c.req.path)
    }
  }

  // 기존 운영본의 R2 JSON을 한 번만 D1으로 자동 이전한다.
  const legacy = await c.env.ASSETS_BUCKET.get('sheet/data.json')
  if (!legacy) return { rev: Number(row?.rev) || 0, data: null }
  try {
    const parsed = JSON.parse(await legacy.text()) as unknown
    if (!isSheetData(parsed)) return { rev: Number(row?.rev) || 0, data: null }
    const metadata = legacy.customMetadata || {}
    const legacyRev = Math.max(1, Number(metadata.rev) || 1)
    const cleaned = stripStoredNumberData(parsed)
    await c.env.DB.prepare(
      `INSERT INTO app_state (id, rev, data_json, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, data_json = excluded.data_json, updated_at = CURRENT_TIMESTAMP`
    ).bind(legacyRev, JSON.stringify(cleaned)).run()
    await recordAdminAudit(c, 'legacy_r2_to_d1', 'app_state', '1', { rev: legacyRev })
    return { rev: legacyRev, data: cleaned }
  } catch (error) {
    logError('legacy R2 sheet migration failed', error, c.req.path)
    return { rev: Number(row?.rev) || 0, data: null }
  }
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

  await c.env.DB.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').bind(key).run()
  const session = await issueAdminToken(c.env.SESSION_SECRET)
  return c.json({ ok: true, token: session.token, expiresAt: session.expiresAt })
})

// ---------- 자료실 API (Cloudflare R2) ----------

// 목록: R2에 저장된 이미지들의 메타데이터(id, name, ts) 반환
app.get('/api/assets', async (c) => {
  try {
    const objects: R2Object[] = []
    let cursor: string | undefined
    do {
      const page = await c.env.ASSETS_BUCKET.list({ prefix: 'assets/', include: ['customMetadata'], cursor })
      objects.push(...page.objects)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    const items = objects.map((o) => {
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
  } catch (error) {
    logError('asset list failed', error, c.req.path)
    return c.json({ ok: false, error: errorMessage(error) }, 500);
  }
});

function isValidAssetId(id: string): boolean {
  return /^[0-9a-f-]{36}\.(?:jpe?g|png|gif|webp|avif)$/i.test(id)
}

// 이미지 원본 조회 (누구나 볼 수 있음 = 공유)
app.get('/api/assets/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidAssetId(id)) return c.json({ ok: false, error: 'invalid asset id' }, 400)
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
    if (!(file instanceof File)) return c.json({ ok: false, error: 'no file' }, 400);
    const f = file;
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
    await recordAdminAudit(c, 'create', 'asset', id, { name: name || f.name || '자료', size: f.size, type: f.type })
    return c.json({ ok: true, asset: { id, name: (name || f.name || '자료'), ts: Date.now(), url: '/api/assets/' + encodeURIComponent(id) } });
  } catch (error) {
    logError('asset upload failed', error, c.req.path)
    return c.json({ ok: false, error: errorMessage(error) }, 500);
  }
});

// 이름 수정 (관리자만): { name }
app.patch('/api/assets/:id', async (c) => {
  if (!(await verifyAdminRequest(c))) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!hasBoundedJsonBody(c, 4096)) return c.json({ ok: false, error: 'bad request' }, 400);
  try {
    const id = c.req.param('id');
    if (!isValidAssetId(id)) return c.json({ ok: false, error: 'invalid asset id' }, 400)
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
    await recordAdminAudit(c, 'rename', 'asset', id, { name: newName })
    return c.json({ ok: true, asset: { id, name: newName } });
  } catch (error) {
    logError('asset rename failed', error, c.req.path)
    return c.json({ ok: false, error: errorMessage(error) }, 500);
  }
});

// 삭제 (관리자만)
app.delete('/api/assets/:id', async (c) => {
  if (!(await verifyAdminRequest(c))) return c.json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const id = c.req.param('id')
    if (!isValidAssetId(id)) return c.json({ ok: false, error: 'invalid asset id' }, 400)
    await c.env.ASSETS_BUCKET.delete('assets/' + id);
    await recordAdminAudit(c, 'delete', 'asset', id)
    return c.json({ ok: true });
  } catch (error) {
    logError('asset delete failed', error, c.req.path)
    return c.json({ ok: false, error: errorMessage(error) }, 500);
  }
});

// ---------- 정산표 데이터 공유 API (Cloudflare D1) ----------
// 구조화된 앱 상태는 D1, 이미지 원본만 R2에 저장한다.
app.get('/api/sheet', async (c) => {
  try {
    const current = await readD1Sheet(c)
    return c.json({ ok: true, rev: current.rev, data: current.data, storage: { data: 'D1', images: 'R2' } })
  } catch (error) {
    logError('sheet read failed', error, c.req.path)
    return c.json({ ok: false, error: errorMessage(error) }, 500);
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
    const cleanedData = stripStoredNumberData(body.data)
    const current = await readD1Sheet(c)
    const curRev = current.rev
    // 낙관적 동시성: baseRev 가 제시됐고 서버 rev 와 다르면 충돌
    if (typeof body.baseRev === 'number' && body.baseRev !== curRev) {
      return c.json({ ok: false, conflict: true, rev: curRev, data: current.data }, 409);
    }
    const needsAdmin = requiresAdminForSheetChange(current.data, cleanedData)
    const isAuthorizedAdmin = needsAdmin ? await verifyAdminRequest(c) : false
    if (needsAdmin && !isAuthorizedAdmin) {
      return c.json({ ok: false, error: 'admin authorization required' }, 403);
    }
    const newRev = curRev + 1;
    const payload = JSON.stringify(stampCellEditTimes(current.data, cleanedData));
    const result = await c.env.DB.prepare(
      'UPDATE app_state SET rev = ?, data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1 AND rev = ?'
    ).bind(newRev, payload, curRev).run()
    if (result.meta.changes !== 1) {
      const latest = await readD1Sheet(c)
      return c.json({ ok: false, conflict: true, rev: latest.rev, data: latest.data }, 409)
    }
    if (isAuthorizedAdmin) await recordAdminAudit(c, 'admin_update', 'app_state', '1', { rev: newRev })
    return c.json({ ok: true, rev: newRev });
  } catch (error) {
    logError('sheet write failed', error, c.req.path)
    return c.json({ ok: false, error: errorMessage(error) }, 500);
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
  <link href="/static/style.css?v=20260806g1" rel="stylesheet">
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
      <i class="fas fa-pen"></i><span class="mode-banner-text">일반 사용자 모드 · 타수와 날짜별 지출은 입력 후 <b>24시간 안에 수정·지움</b>할 수 있습니다. 이후 변경과 총액 입력은 관리자만 가능합니다.</span>
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
      <p class="admin-note"><i class="fas fa-circle-info"></i> 관리자 모드에서는 회원·날짜·타수·금액·문구의 <b>전체 데이터</b>와 자료실 <b>이미지</b>를 관리하고 삭제할 수 있습니다. 일반 사용자는 기존 데이터를 삭제할 수 없습니다.</p>

      <div class="admin-cards">
        <div class="admin-card storage-card">
          <h3><i class="fas fa-cloud"></i> Cloudflare 분리 저장 구조</h3>
          <div class="storage-architecture">
            <div><b>D1 데이터베이스</b><span>회원 · 날짜 · 타수 · 평균타수 · 화면 문구 · 관리자 작업 이력</span></div>
            <div><b>R2 이미지 저장소</b><span>업로드한 이미지 원본만 전용 보관</span></div>
          </div>
        </div>
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
          <p class="admin-desc"><i class="fas fa-cloud"></i> 이미지는 <b>Cloudflare R2 이미지 전용 저장소</b>에 보관됩니다. 등록·이름 변경·삭제는 관리자만 가능하며, 보기는 모든 사용자가 가능합니다. (이미지당 최대 8MB)</p>
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

  <!-- 타수 빠른입력 숫자판: 완료를 눌렀을 때만 서버에 저장 -->
  <div id="quick-pad" class="quick-pad hidden">
    <div id="quick-label" class="quick-pad-label">회원 · 날짜</div>
    <div class="quick-pad-cur"><span id="quick-cur">0</span> 타</div>
    <div class="quick-pad-btns">
      <button class="qp-btn" data-score="80">80</button>
      <button class="qp-btn" data-score="81">81</button>
      <button class="qp-btn" data-score="82">82</button>
      <button class="qp-btn" data-score="90">90</button>
      <button class="qp-btn" data-score="91">91</button>
      <button class="qp-btn" data-score="92">92</button>
      <button class="qp-btn" data-score="100">100</button>
      <button class="qp-btn" data-score="101">101</button>
      <button class="qp-btn" data-score="102">102</button>
      <button class="qp-btn qp-clear" data-clear="1"><i class="fas fa-eraser"></i> 지움</button>
      <button class="qp-btn qp-done qp-wide"><i class="fas fa-check"></i> 완료</button>
    </div>
  </div>

  <div id="expense-quick-pad" class="quick-pad expense-quick-pad hidden">
    <div id="expense-quick-label" class="quick-pad-label">날짜별 지출</div>
    <div class="quick-pad-cur"><span id="expense-quick-cur">0</span> 원</div>
    <div class="quick-pad-btns">
      <button class="qp-btn expense-preset" data-expense-value="10000">1만</button>
      <button class="qp-btn expense-preset" data-expense-value="20000">2만</button>
      <button class="qp-btn expense-preset" data-expense-value="50000">5만</button>
      <button class="qp-btn expense-preset" data-expense-value="100000">10만</button>
      <button class="qp-btn expense-preset" data-expense-value="200000">20만</button>
      <button class="qp-btn expense-preset" data-expense-value="250000">25만</button>
      <button class="qp-btn qp-clear" data-expense-clear="1"><i class="fas fa-eraser"></i> 지움</button>
      <button class="qp-btn qp-done qp-wide" data-expense-done="1"><i class="fas fa-check"></i> 완료</button>
    </div>
  </div>
  <div id="input-toast" class="input-toast hidden" role="status" aria-live="polite">입력되었습니다</div>

  <!-- 이미지 크게 보기 -->
  <div id="img-modal" class="modal hidden">
    <div class="img-view">
      <button id="img-close" class="img-close"><i class="fas fa-xmark"></i></button>
      <img id="img-big" src="" alt="" />
      <div id="img-caption" class="img-caption"></div>
    </div>
  </div>

  <script src="/static/app.js?v=20260806g1"></script>
</body>
</html>`)
})

export default app
