# ThinkSL8 for Mac

A native macOS app (Swift, macOS 12+, Apple silicon and Intel) that works **offline** and syncs with thinksl8.com.

- Same canvas UI as the website: `public/` is bundled inside the app and shown from a local server on 127.0.0.1 (`Http.swift`). The server only answers this app's own window (random launch cookie, Host check).
- `Local.swift` answers the site's own `/api/*` calls from a local SQLite database (`Store.swift`): canvases, items, search, photos/videos/voice recordings. Accounts, sharing, AI, marketplace, export pass through to thinksl8.com when online.
- `Sync.swift` sends what changed on this Mac (new/renamed/deleted canvases, item puts/deletes, files) and pulls what changed elsewhere, using the server's existing protocol (`/api/notes`, `?since=`, `/ops`). Per item the last save wins; anything changed here and not sent yet is never overwritten. Runs at launch, when the network returns, every 30 s, after local edits, and from File → Sync Now. The window subtitle shows the state.
- Sign in once while online. After that it opens and works with no connection.
- Server changes it needs (already in this branch): `POST /api/notes` accepts a client-chosen `id`, and `POST /api/files?id=` too, so things made offline keep the same id when they reach the server. Merge and deploy these before using the app against production.

## Build

The "Mac app" workflow builds on a macOS runner on pushes touching `mac/` or `public/`, or by hand. Download the `thinksl8-mac` artifact, open the `.dmg`, drag ThinkSL8 to Applications. Locally: `bash mac/build.sh`.

Ad-hoc signed, not notarized (no Apple Developer account). First launch: right-click the app → Open. If macOS says it is damaged: `xattr -dr com.apple.quarantine /Applications/ThinkSL8.app`.

Data lives in `~/Library/Application Support/ThinkSL8`. Signing out, or signing in as a different account, clears it.

## Known limits

- Sharing links, AI, marketplace, account settings need a connection.
- No live push between devices (no WebSocket in the app): it polls every 30 s and on edits.
- Style-only changes made on another device (look/background) arrive when that canvas next changes.
