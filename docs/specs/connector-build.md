# ThinkSL8 AI connector: build specs for Max

Author: Jet (claude.ai). Builder: Max (org Claude, Josh's laptop). Reviewer: Jet. Merges: Josh only.
Goal: ThinkSL8's MCP connector (https://thinksl8.com/mcp, OAuth 2.1, per-user) works with every AI app, each user using their own account.
Where things are: `src/index.js` (OAuthProvider wrap), `src/mcp.js` (tools, consent screen, `buildServer`, `McpApi`, `authorize`), `src/hooks.js` (the `/alerts` page is the pattern to copy for a new page: `currentUser`, same-origin check on POST, the `page()` and `esc()` helpers), `test/*.mjs` (API tests), `.github/workflows/tests.yml` (CI runs them all). README.md "Run and test locally" shows how to run everything.

## Ground rules

1. Work on a branch named `max/<task>` (for example `max/j2-annotations`). One branch and one PR per task. Do not merge. Do not push to `main`.
2. Do not touch OAuth/token code in `src/index.js` or the consent screen, and do not add personal access tokens: Jet does those (J1, J4). Do not change `src/hooks.js` behaviour.
3. Run the test suites you can (README) and add tests for what you build. CI runs them on every push; paste CI's result in your report.
4. Use scratch canvases for any manual test. Never read or change Josh's real canvases.
5. No secrets, tokens or personal data in code, tests, commits or reports.
6. Production database changes: write the migration file (`migrations/0010_*.sql`), but never apply it. Josh applies it, then merges. New code must not crash if the table does not exist yet (wrap in try/catch, show "not set up yet").
7. Commit messages end with: `Co-Authored-By: Max (Claude) <noreply@anthropic.com>`
8. Report to the bridge, one entry per task, with: branch name, files changed, test result, anything you were unsure about. If you cannot push to GitHub, see "If you cannot push" below.

## Step 0: capability probe (do this first, report it)

Report in one entry: can you run `git`, `node -v`, `npm -v`, `npx wrangler --version`? Can you reach github.com (clone `https://github.com/rng-dle/sl8`, branch `jet/specs`)? Can you push a branch? Which folders can you write to? Do not install anything big; just report.

## If you cannot push

Write the finished files in a local folder and paste each changed or new file in full into its own bridge note (a note holds up to 40,000 characters; use the header `FROM: Max | TO: Jet | STATUS: open`, Subject `FILE <path>`, and the whole file in the body). Jet commits them, runs CI and reviews. Say which files are complete replacements.

## J2: tool hints (small; do this first)

In `src/mcp.js`, every `s.registerTool(name, config, handler)` gets `config.title` (short, human) and `config.annotations`:
- Read-only tools (`list_canvases`, `read_canvas`, `search`, `get_voice_note`): `{ readOnlyHint: true, openWorldHint: false }`.
- Adds (`create_canvas`, `add_note`, `add_portal`, `add_voice_note`): `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }`.
- Changes (`set_voice_transcript`, `update_item`, `rename_canvas`): `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }`.
- `delete_item`: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }`.
Done when: `test/mcp-test.mjs` asserts every tool returned by `tools/list` has a title and annotations, read-only tools have `readOnlyHint: true`, and no write tool does. Check the installed SDK's `registerTool` typings (`node_modules/@modelcontextprotocol/sdk`) to confirm the field names before coding.

## J3: Connected apps page `/apps`

A signed-in user sees every AI app they have connected, what each may do, when it was approved and last used, and can revoke it.
- Route `/apps`, handled like `/alerts`: add `/apps` to `run_worker_first` in `wrangler.toml`, a function `appsPage(req, env)` in a new `src/apps.js`, called from the `defaultHandler` chain in `src/index.js` (after `authorize`, next to `alertsPage`).
- Data: the provider exposes helpers on `env.OAUTH_PROVIDER`. Read `node_modules/@cloudflare/workers-oauth-provider` typings and use `listUserGrants(userId)` (grants: id, clientId, scope, metadata, createdAt), `lookupClient(clientId)` (clientName) and `revokeGrant(grantId, userId)`. Show client name (fall back to `metadata.client`, then the clientId), scopes in words ("read canvases", "add notes", "edit and delete"), approved date, and last used (from J5's log, "never" if none).
- Revoke: a POST form with the grant id, same-origin check, calls `revokeGrant`. Revoking must make the app's next call fail with 401.
- Only the signed-in user's own grants are ever listed or revoked (test: a second user cannot see or revoke the first user's grant).
- Link to it from `public/settings.html` ("Connected apps") and from the top of `/alerts`.
Done when: `test/apps-test.mjs` (new; copy the setup of `test/mcp-test.mjs`, which already registers a client and gets a token) covers: grant is listed, revoke works and the old token then gets 401, another user cannot revoke it. Add the test to `.github/workflows/tests.yml` next to the others.

## J5: audit log and rate limit

- Migration `migrations/0010_mcp_calls.sql`: table `mcp_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL, canvas_id TEXT, ok INTEGER NOT NULL, at INTEGER NOT NULL)` and an index on `(user_id, at)`. Do not apply it.
- In `buildServer` wrap every tool handler once (a small helper that replaces direct `s.registerTool` use) so it records user, client name, tool, canvas id (if the input has one), success, time. Add the client name to the approved `props` in `authorize` (`client: client?.clientName || ''`). Write the row with `ctx.waitUntil` and swallow errors; a logging failure must never fail a tool call.
- Rate limit: more than 120 calls in 60 seconds for one user returns the tool error "Too many requests, wait a minute." (count rows in `mcp_calls`). If the table is missing, skip the limit.
- Prune in the existing `scheduled()` handler: delete rows older than 30 days.
- Show the latest 50 calls on `/apps` (time, app, tool, canvas title) and use it for "last used".
Done when: tests cover a call being logged, the 121st call in a minute being refused, and a missing table not breaking calls.

## J7: setup page `/connect`

A static page, `public/connect.html` (served directly from assets; no worker change), styled like `public/privacy.html` and `public/style.css`.
- Top: one sentence on what connecting does, the connector URL `https://thinksl8.com/mcp` with a copy button, and the plain statement that anything the AI reads goes to the user's AI provider.
- One section per app. Only write steps that have been tested. Today that is only Claude: Settings, Connectors, Add custom connector, paste the URL, sign in to ThinkSL8, tick what to allow, Allow. Every other app (ChatGPT, Gemini, Perplexity, Grok, Mistral Le Chat, local apps) gets a short "Not tested yet" line, no invented steps. Jet will send tested steps as Josh and Max report them; update the page then.
- Explain the two permissions in plain words ("add notes", "edit and delete").
- Link to `/apps` for revoking, and link `/connect` from `public/settings.html`.
Done when: the page loads at `/connect`, passes a mobile-width check (no sideways scroll at 360 px), and every link works.

## Order and review

Order: step 0, J2, J5, J3, J7 (J3 needs J5's log for "last used"). Report each as it is done; Jet reviews each PR (reads the diff, runs it, checks CI) and sends fixes back as `TO: Max` entries. Josh merges after Jet's `done`.
