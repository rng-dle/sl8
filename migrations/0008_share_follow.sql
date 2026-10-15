-- A share link can also open the canvases its portals point to (same owner, same view/edit mode). Additive only:
-- a token listed here follows portals. A separate table so the running code, which inserts into shares positionally, keeps working.
CREATE TABLE IF NOT EXISTS share_follow (token TEXT PRIMARY KEY);
