PRAGMA foreign_keys = ON;

-- 정산표 전체 상태와 낙관적 잠금 버전. 이미지 바이너리는 이 테이블에 넣지 않는다.
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  data_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO app_state (id, rev, data_json) VALUES (1, 0, NULL);

-- 로그인 실패 제한도 D1에서 관리하여 R2를 이미지 전용으로 유지한다.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_start INTEGER NOT NULL
);

-- 관리자 작업 이력. 비밀번호나 세션 토큰은 기록하지 않는다.
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit(created_at DESC);
