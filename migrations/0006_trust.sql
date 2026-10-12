-- Email verification and canvas history. Additive: the running code keeps working.
ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET verified = 1; -- accounts made before verification existed
CREATE TABLE IF NOT EXISTS verifies (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Every item's previous version (data NULL: it didn't exist yet), written by triggers so every write path is covered.
-- Restoring a canvas to time T puts each item changed after T back to its earliest version after T.
CREATE TABLE IF NOT EXISTS item_history (
  note_id TEXT NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS item_history_note ON item_history (note_id, at);
CREATE TRIGGER IF NOT EXISTS items_hist_ins AFTER INSERT ON items BEGIN
  INSERT INTO item_history VALUES (new.note_id, new.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), NULL);
END;
CREATE TRIGGER IF NOT EXISTS items_hist_upd AFTER UPDATE OF data ON items WHEN old.data IS NOT new.data BEGIN
  INSERT INTO item_history VALUES (old.note_id, old.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), old.data);
END;
CREATE TRIGGER IF NOT EXISTS items_hist_del AFTER DELETE ON items BEGIN
  INSERT INTO item_history VALUES (old.note_id, old.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), old.data);
END;
