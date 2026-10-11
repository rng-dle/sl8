-- Account basics: password reset tokens, request throttling, faster per-user session lookups.
CREATE TABLE IF NOT EXISTS resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS throttle (
  key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
