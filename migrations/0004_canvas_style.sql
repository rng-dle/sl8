-- Per-canvas look: theme, background colour, pattern, uploaded image (JSON in `style`).
-- A separate table so the running code, which inserts into notes without a column list, keeps working.
CREATE TABLE IF NOT EXISTS canvas_style (
  note_id TEXT PRIMARY KEY,
  style TEXT NOT NULL DEFAULT '{}'
);
