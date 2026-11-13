-- Guest demo sessions: throwaway accounts seeded with the demo canvases (src/demo.js), purged after 24 hours.
-- Additive only: the running code ignores the column.
ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS users_guest ON users (guest, created_at);
