-- Sharing and sync between devices. Additive only: the running code ignores these.
-- A share is a link: view or edit, for the whole canvas ('*') or a JSON list of dot-grid containers ("level/col/row").
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  area TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_note ON shares (note_id);
-- deleted item ids, so other open devices can drop them too (kept about a day)
CREATE TABLE IF NOT EXISTS tombstones (
  note_id TEXT NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (note_id, id)
);
CREATE INDEX IF NOT EXISTS items_changed ON items (note_id, updated_at);
