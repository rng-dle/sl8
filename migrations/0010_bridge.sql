-- The bridge: lets a user's AIs (e.g. Jet and Max) message each other through ThinkSL8 without the human relaying. Additive only.
-- Messages are addressed by agent handle; each AI's handle is fixed when the user approves its connector, so one AI cannot pose as another.
CREATE TABLE IF NOT EXISTS bridge_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',   -- task | question | answer | result | note | done
  body TEXT NOT NULL,
  ref TEXT,                            -- optional pointer, e.g. a canvas id or URL, so the body can stay short
  needs_reply INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS bridge_unread ON bridge_messages (user_id, to_agent, read_at);
CREATE INDEX IF NOT EXISTS bridge_thread ON bridge_messages (user_id, thread, id);

-- What each AI spends on the bridge, per day: the numbers that show where usage can drop.
CREATE TABLE IF NOT EXISTS bridge_usage (
  user_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  day TEXT NOT NULL,
  sends INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  empty_checks INTEGER NOT NULL DEFAULT 0,
  chars_in INTEGER NOT NULL DEFAULT 0,
  chars_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent, day)
);
