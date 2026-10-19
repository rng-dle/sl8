-- Alerts for a canvas: when a connected AI adds or changes something on it, wake a Claude routine (its API trigger) or email
-- the owner. Additive only. The routine token is sealed with KEY_ENC_SECRET like AI provider keys.
CREATE TABLE IF NOT EXISTS canvas_hooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'routine' or 'email'
  label TEXT NOT NULL DEFAULT '',
  url TEXT,                      -- routine fire URL (https://api.anthropic.com/v1/claude_code/routines/trig_.../fire)
  secret TEXT,                   -- sealed routine token
  match TEXT NOT NULL DEFAULT '',-- fire only when the new text contains one of these (separated by |); empty = always
  cooldown INTEGER NOT NULL DEFAULT 120, -- seconds between fires; changes inside it wait for the next fire
  last_fired_at INTEGER,
  pending_since INTEGER,
  pending_note TEXT,
  last_status TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS canvas_hooks_note ON canvas_hooks (note_id);
CREATE INDEX IF NOT EXISTS canvas_hooks_user ON canvas_hooks (user_id);
