# 개발 인수인계 문서 (다른 AI/개발자용)

이 문서는 **골프 페널티 정산표** 프로젝트를 다른 AI 또는 개발자가 이어받아
수정할 수 있도록 구조와 핵심 파일을 설명합니다.
(최종 업데이트: 2026-07-29 — 양지번호/관리자모드/자료실/천원빠른입력/정렬버그수정 반영)

## 1. 프로젝트 개요
- 골프 모임 회원(기본 8명)의 날짜별 페널티(벌금) 금액을 기록·합산하는
  엑셀/구글시트 형식의 단일 페이지 웹앱.
- **서버 DB 없음**. 모든 데이터는 브라우저 `localStorage`에 저장됨
  (키: `golf-penalty-sheet-v3`).
- 프레임워크: **Hono + Vite**, 배포 대상: **Cloudflare Pages**.
- 라이브 URL: https://golf-penalty.pages.dev
  (배포 계정: 사용자 본인 Cloudflare 계정 = BYOK 방식)

## 2. 기술 스택
| 항목 | 내용 |
|---|---|
| 백엔드 | Hono (Cloudflare Pages Functions) — HTML 한 페이지만 서빙 |
| 프론트 | 순수 Vanilla JS (프레임워크 없음) |
| 스타일 | 순수 CSS (Font Awesome 아이콘만 CDN) |
| 빌드 | Vite (`@hono/vite-build/cloudflare-pages`) |
| 저장 | 브라우저 localStorage (외부 API/DB 없음) |

## 3. 핵심 파일 (여기만 보면 됨)
```
src/index.tsx           ← 페이지 HTML 전체 (헤더/버튼/표 뼈대/모달/빠른입력 팝오버). 페이지 구조 수정
public/static/app.js    ← ★ 모든 로직 (렌더링, 합계 계산, 입력, 저장, CSV, 관리자, 자료실, 빠른입력). 기능 수정은 대부분 여기
public/static/style.css ← ★ 모든 디자인 (색상/글씨/그리드/반응형/팝오버). 디자인 수정은 여기
```
그 외 `vite.config.ts`, `wrangler.jsonc`, `package.json`, `tsconfig.json`,
`ecosystem.config.cjs`는 빌드/배포 설정이라 보통 손댈 필요 없음.
`src/renderer.tsx`는 템플릿 잔재로 현재 미사용.

## 4. app.js 데이터 모델 (localStorage 키: golf-penalty-sheet-v3)
```js
state = {
  members: [{ id, name, phone }],   // 회원 행 (기본 8개 빈 행). phone = "양지번호"
  dates:   [{ id, iso }],           // iso = "YYYY-MM-DD", 날짜순 자동 정렬 (기본 1개=오늘)
  cells:   { "memberId|dateId": 금액(number) },  // 각 셀 값 (0~100000)
  manager: { name, phone },         // 담당자 정보
  widths:  { "컬럼키": px },         // 사용자가 드래그로 조절한 컬럼 폭
  assets:  [{ id, name, data(base64 dataURL), ts }]  // ★ 관리자 자료실 이미지
}
```
- 합계: `memberTotal(id)`(회원별), `dateTotal(id)`(날짜별), `grandTotal()`(전체).
- 렌더: `render()` → `renderHead()` / `renderBody()` / `renderFoot()` → `applyWidths()` → `syncStickyOffset()`.
- 입력 중에는 `refreshTotals()`로 합계만 갱신(성능).
- 저장은 모든 변경 후 `save()` 호출 (localStorage 직렬화).

## 5. 주요 기능과 관련 함수 (app.js)
- **금액 상한**: `MAX_MONEY = 100000` (십만원). 초과 입력 시 자동 고정.
- **천원 단위 빠른입력 팝오버**: `openQuickPad()`, `positionQuickPad()`,
  `applyQuickValue()`, `closeQuickPad()`. HTML은 `index.tsx`의 `#quick-pad`.
  금액칸 포커스 시 그 칸 아래에 뜸(+1천/2천/3천/5천/1만/지움/완료).
- **권한 분리**: `isAdmin` 플래그. 일반 사용자는 빈 칸에 새 입력만 가능,
  이미 값이 있는 칸은 readonly(잠금). 관리자만 수정·삭제·초기화 가능.
  - `inputCls()`가 잠금 클래스 부여, 입력 핸들러에서 재차 차단.
- **관리자 로그인**: `ADMIN_ID = 'admin'`, `ADMIN_PW = 'admin1234'`.
  `tryLogin()` / `openAdmin()` / `closeAdmin()`.
- **자료실**: `renderAssets()`, 이미지 add(FileReader→base64)/delete/크게보기.
- **CSV/백업/복원**: `exportCsv()`, 백업(JSON `state` 통째로), 복원(파일→state).
- **컬럼 리사이즈**: 마우스+터치. `startResize/moveResize/endResize`.
- **★ 정렬 핵심 (건드릴 때 주의)**:
  - `.sheet`에는 절대 `min-width: 100%`를 넣지 말 것. 표가 화면을 채우려
    컬럼을 비례 확대해 지정 px가 무시되고 헤더-바디가 어긋남. `width: max-content`만 사용.
  - 왼쪽 고정(sticky) '회원 이름' 칸의 `left` 오프셋은 CSS 변수가 아니라
    `syncStickyOffset()`가 'No' 칸 실제 렌더 폭을 측정해 JS로 설정함.
    컬럼 폭/구조를 바꾸면 이 함수가 자동 재보정하므로 그대로 두면 됨.

## 6. 컬럼 폭 규격 (style.css :root 변수, px 고정)
```
--w-no: 54px      /* No: 숫자 3자리 */
--w-name: 132px   /* 회원 이름: 한글 6자 */
--w-phone: 96px   /* 양지번호: 숫자 6자리 */
--w-date: 92px    /* 날짜/금액: 십만원 */
--w-total: 110px  /* 합계 */
```
(모바일 @media max-width:640px 에서 더 좁은 값으로 재정의)

## 7. 로컬 실행 방법
```bash
# 의존성 설치 (최초 1회)
npm install

# 개발/미리보기 (Cloudflare Pages 로컬 서버)
npm run build
npx wrangler pages dev dist --ip 0.0.0.0 --port 3000
# 또는 PM2: pm2 start ecosystem.config.cjs

# 브라우저에서 http://localhost:3000 접속
```
> 정적 파일(app.js/style.css)을 고치면 `npm run build`로 dist를 다시 빌드해야 반영됨.

## 8. Cloudflare Pages 배포
```bash
npm run build
npx wrangler pages deploy dist --project-name golf-penalty --branch main
```
(Cloudflare API 토큰/로그인 필요. 사용자 본인 계정으로 배포하는 BYOK 방식)

## 9. 자주 하는 수정 가이드
- **기본 회원 수 변경**: `app.js` 상단 `DEFAULT_ROWS = 8` 수정.
- **금액 상한 변경**: `app.js` 상단 `MAX_MONEY = 100000` 수정 + 팝오버 버튼 금액.
- **관리자 비밀번호 변경**: `app.js` 상단 `ADMIN_PW` 수정 (주의: 프론트 코드라 노출됨. 진짜 보안 필요 시 서버 인증 도입).
- **빠른입력 버튼 금액 바꾸기**: `index.tsx`의 `#quick-pad` 안 `data-add` 값들 수정.
- **색상 변경**: `style.css` 최상단 `:root` 변수(--green 등) 수정.
- **여러 명 실시간 공유**: 현재 localStorage → Cloudflare D1/KV 등으로 교체 필요
  (app.js의 load/save를 fetch API 호출로 바꾸고 Hono에 API 라우트 추가).

## 10. 자료실 이미지 = Cloudflare R2 (서버 저장) ★★★
- 자료실 이미지는 이제 **서버(Cloudflare R2 버킷 `golf-penalty-assets`)에 저장**됨.
  모든 사용자가 같은 이미지를 공유하고, 브라우저를 지워도 사라지지 않으며 영구 보관됨.
- 소스 코드에는 이미지가 없음(당연). 이미지 백업은 R2가 자동으로 담당.
- **API (src/index.tsx)**:
  - `GET  /api/assets`      → 목록 JSON `{ok, assets:[{id,name,ts,url}]}` (인증 불필요)
  - `GET  /api/assets/:id`  → 이미지 원본 바이너리 (인증 불필요, 공유)
  - `POST /api/assets`      → 업로드 multipart(file,name) (헤더 `x-admin-key` 필요)
  - `DELETE /api/assets/:id`→ 삭제 (헤더 `x-admin-key` 필요)
- **쓰기 보호**: `checkAdmin()`가 `x-admin-key` 헤더를 secret `ADMIN_KEY`와 비교.
  - 프론트(app.js)는 관리자 로그인 시 입력한 비밀번호를 `adminKey`에 저장해 헤더로 보냄.
  - 로컬 개발: `.dev.vars`의 `ADMIN_KEY`(=admin1234). 깃 커밋 안 됨.
  - 프로덕션: `npx wrangler pages secret put ADMIN_KEY --project-name golf-penalty` 로 설정.
  - ⚠️ 관리자 PW를 바꾸면 app.js의 `ADMIN_PW`와 서버 secret `ADMIN_KEY`를 **둘 다** 바꿔야 함(일치 필요).
- **R2 바인딩**: wrangler.jsonc `r2_buckets` → binding `ASSETS_BUCKET`, bucket `golf-penalty-assets`.
  로컬은 `wrangler pages dev`가 자동으로 로컬 R2 생성. 배포는 `wrangler pages deploy`가 바인딩 반영.
  - 배포 직후 별칭 도메인 캐시로 잠깐 404가 날 수 있으나 20~30초 뒤 정상.
- **정산 데이터(회원/날짜/금액)** 는 여전히 브라우저 localStorage(`golf-penalty-sheet-v3`).
  관리자 [전체 백업(JSON)]은 이 정산 데이터만 담음(이미지는 R2에 있으니 제외).
- 파비콘은 `index.tsx` 내 인라인 SVG(⛳ 이모지) 사용. 아이콘은 Font Awesome CDN.
