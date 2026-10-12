-- Email verification. Additive: the running code keeps working.
ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET verified = 1; -- accounts made before verification existed
CREATE TABLE IF NOT EXISTS verifies (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
