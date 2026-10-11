-- ThinkSL8 v1: onboarding flag, item edit times, full-text index for AI retrieval, AI connections and usage.
-- Additive only: the previous Worker keeps working against this schema.
ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0;
UPDATE users SET onboarded = 1;

ALTER TABLE items ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE items SET updated_at = t;

-- typed text only; kept in sync by triggers so every write path (old and new code) maintains it
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(text, tokenize = 'porter unicode61');
INSERT INTO items_fts (rowid, text)
  SELECT rowid, json_extract(data, '$.text') FROM items WHERE json_extract(data, '$.kind') = 'text';
CREATE TRIGGER IF NOT EXISTS items_fts_ins AFTER INSERT ON items WHEN json_extract(new.data, '$.kind') = 'text' BEGIN
  INSERT INTO items_fts (rowid, text) VALUES (new.rowid, json_extract(new.data, '$.text'));
END;
CREATE TRIGGER IF NOT EXISTS items_fts_del AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS items_fts_upd AFTER UPDATE OF data ON items BEGIN
  DELETE FROM items_fts WHERE rowid = old.rowid;
  INSERT INTO items_fts (rowid, text) SELECT new.rowid, json_extract(new.data, '$.text') WHERE json_extract(new.data, '$.kind') = 'text';
END;

CREATE TABLE IF NOT EXISTS ai_connections (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  secret TEXT NOT NULL,
  hint TEXT NOT NULL,
  model TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'canvas',
  status TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
