# ThinkSL8

Think without boundaries. An infinite canvas for typed, handwritten and drawn thoughts, with the user's own AI connected to what they've written. Live at https://thinksl8.com.

One Cloudflare Worker (`sl8`): static pages in `public/` (served directly), API in `src/worker.js` (only `/api/*` runs code), AI in `src/ai.js`, email in `src/mail.js`, data in D1 (`sl8-db`). No framework, no build step. Product brief, provider research and the v1 plan: [`docs/PLAN.md`](docs/PLAN.md).

## Deploy

Pushes to `main` deploy through Cloudflare Workers Builds (Workers & Pages → `sl8` → Settings → Builds, repo `rng-dle/sl8`). Builds don't run database migrations: apply new files in `migrations/` first (they're written to be safe for the code already running). By hand, with Node 18+:

```
npm install && npx wrangler login && npx wrangler d1 migrations apply sl8-db --remote && npx wrangler deploy
```

AI connections need one secret, `KEY_ENC_SECRET` (any random string of 32+ characters), which encrypts users' provider keys. Set it in the dashboard (`sl8` → Settings → Variables and Secrets) or with `npx wrangler secret put KEY_ENC_SECRET`. Without it the app works and AI shows as unavailable. Changing it later disconnects everyone's AI, so set it once.

Password reset needs an email sender. Either:
- **Resend** (free tier): create an account, add `thinksl8.com` as a sending domain (Resend can add the DNS records to Cloudflare for you), then add the API key as the secret `RESEND_API_KEY`.
- **Cloudflare Email Sending** (public beta, Workers Paid plan): onboard `thinksl8.com` in Email Service and add a `send_email` binding named `EMAIL`.

The bot check (Cloudflare Turnstile) on sign-up, sign-in and reset requests switches on once both keys are set: in Cloudflare → Turnstile → Add widget, use hostname `thinksl8.com` and mode Managed, then add the site key as the variable `TURNSTILE_SITE_KEY` and the secret key as the secret `TURNSTILE_SECRET` (`sl8` → Settings → Variables and Secrets).

Mail goes out from `no-reply@thinksl8.com` (override with a `MAIL_FROM` variable). Until one is set up, "Forgot your password?" says reset isn't available yet.

`sl8.nastaliq.co` still serves the app (same data, separate sign-in). To forward it to thinksl8.com, add a Redirect Rule for that hostname in Cloudflare, or remove it from `routes` in `wrangler.toml`.

## Run and test locally

`.dev.vars` (git-ignored) holds the local secret and points AI and email at a local stand-in, so nothing real is called:

```
printf 'KEY_ENC_SECRET="local-dev-only-secret-0123456789abcdef"\nTEST_BASE="http://127.0.0.1:8788"\nRESEND_API_KEY="test-resend-key"\n' > .dev.vars
npx wrangler d1 migrations apply sl8-db --local
node test/fake-provider.mjs &
npx wrangler dev --port 8787 --local-upstream 127.0.0.1:8787
```

Then, in another terminal:

```
bash test/smoke-test.sh && node test/ai-test.mjs && node test/account-test.mjs && node test/share-test.mjs && node test/share-follow-test.mjs && node test/market-test.mjs && node test/voice-test.mjs && node test/mcp-test.mjs && python3 test/pen-test.py && python3 test/journey.py && python3 test/share-journey.py && python3 test/voice-journey.py
```

- `smoke-test.sh`: accounts, saving, isolation between users, lockout (per account and network, so strangers can't lock you out), logout.
- `bot-test.mjs`: the bot check, against a second `wrangler dev --port 8789 --var TURNSTILE_SITE_KEY:test-site --var TURNSTILE_SECRET:test-secret`.
- `ai-test.mjs`: AI connections, encryption at rest, OpenRouter sign-in (PKCE), scopes, retrieval, every error state, the daily cap.
- `account-test.mjs`: email confirmation (sharing waits for it), password reset by email, change password, log out everywhere, export, search, account deletion, rate limits, the 404 page.
- `share-test.mjs`: share links (whole canvas or squares, view or edit), area checks on every write, files through links, catching up on changes and deletes.
- `share-follow-test.mjs`: links that also open the canvases their portals point to (opt-in, whole canvas only): what they reach, what stays private, view vs edit, turning off.
- `market-test.mjs`: the marketplace at `/market`: browsing signed out, publishing a canvas or JSON as a template (photos, videos and portals left out), using a template or theme, taking down.
- `voice-test.mjs`: recordings as files (WebM, MP4, Ogg, MP3, WAV), voice items and transcripts, byte-range playback, links can't add them.
- `voice-journey.py`: record from a fake microphone in a browser, the capsule appears, survives a reload, plays and pauses.
- `pen-test.py`: simulated S Pen with a resting palm, and the "Draw with finger" toggle.
- `share-journey.py`: sharing chosen squares in a browser, someone without an account editing inside them, the owner's canvas and second device picking changes up, view links.
- `tour-test.py`: the guided tour from setup, every step, on a phone, a phone that has used a pen, and a desktop; double-tap to write; Show me around.
- `journey.py`: the whole journey in a browser, from signup through setup, the reveal, writing, selecting, asking AI and reloading, to settings, search, password reset and a phone layout.

The Python tests need `pip install playwright && playwright install chromium`.

## How the AI works

- **Connecting:** "Continue with OpenRouter" is a real OAuth PKCE flow. OpenRouter returns a key owned by the user, billed to their OpenRouter account, with free models available. OpenAI, Anthropic and Gemini connect by API key under Settings → AI → Advanced. Keys are checked against the provider before saving, encrypted with AES-GCM and never sent to the browser.
- **Asking:** the server gathers typed text from the scope the user allows (selection, current canvas, or all canvases) and sends it with the question. When a scope has too much text to send whole, it uses SQLite FTS5 keyword search plus the most recent edits. Answers stream back with numbered sources that link to the original notes. "Add to canvas" is the only way an answer reaches the canvas, and Undo removes it.
- **Limits:** 200 AI requests per user per day. Handwriting isn't readable by the AI yet.

## Connect your own AI (MCP)

ThinkSL8 is a remote MCP server at `https://thinksl8.com/mcp` (OAuth 2.1, Streamable HTTP, stateless). In Claude, add a custom connector with that URL; sign in to ThinkSL8 in the same browser when asked, then approve. Approval is read-only unless you tick "Also allow adding voice notes and transcripts".

Tools: `list_canvases`, `read_canvas`, `search` (typed notes and voice transcripts), `get_voice_note` (transcript and optionally the audio, up to 2 MB), and, with write access, `set_voice_transcript` and `add_voice_note`. Every query is scoped to the signed-in user's own canvases. Writes go through the same validation and live sync as the app.

Built on Cloudflare's `@cloudflare/workers-oauth-provider` and `agents` (`createMcpHandler`). `src/index.js` wraps the app with the provider; `src/mcp.js` has the consent screen and the tools. It needs the KV binding `OAUTH_KV` (one namespace, created once). Tokens are issued for `https://thinksl8.com/mcp`, so the connector only works on that address (set `MCP_RESOURCE` to test elsewhere, and run `wrangler dev` with `--local-upstream`). Approving again for the same app replaces its earlier grant. Test: `node test/mcp-test.mjs`.

## Using it

- **Select tool (V):** drag a box to select ink and text, drag to move, Delete to remove. Double-tap or double-click empty space to write.
- **Voice notes (mic button):** tap to record, tap again to stop (ten minutes at most). A capsule appears on the canvas with play/pause; it syncs like any other item. A recording is a `voice` item (`file`, `dur`, optional `text` transcript) whose audio lives in the same file store as photos and videos. Links can move a capsule but not add one.
- **Pen (P), highlighter (H), eraser (E), text (T).** An S Pen's side button or a tablet pen's eraser end erases while held.
- **Fingers:** once a pen has been used on the device, fingers move the page. A finger tap still counts: double-tap writes, and the text tool starts a note where you tap. "Draw with finger", next to the pen colours, switches that back.
- **Desktop:** the wheel pans, Ctrl + wheel or a trackpad pinch zooms, and holding Space lets you drag. Ctrl+Z and Ctrl+Shift+Z undo and redo.
- **Appearance:** theme and canvas background in the ⋯ menu or Settings. The opening animation can be set to Full, Short or Off.
- **Saving:** changes save every second. Offline edits stay on the device and are sent when the connection returns.
- **Sync:** each open canvas keeps a WebSocket to its live room (a Durable Object, `Room` in `src/worker.js`). Your own other copies see a stroke while it's being drawn, and get each save's changes in the push itself; a share link's copy only hears a ping and fetches the usual way, so it never sees past its squares (and only your own copies can stream strokes). Other tabs in the same browser get changes over a BroadcastChannel. Polling stays as a slow safety net (every 15 s while connected, every second if the socket drops). The `Room` class is created by the migration in `wrangler.toml` on the next deploy.
- **Sharing (⋯ → Share…):** a link to view or edit, for the whole canvas or for chosen squares of the dot grid. Squares follow the zoom (96 to 192 px on screen when picked); each one holds the four smaller squares inside it, and an item belongs to the square its first point is in. People with the link need no account. The server checks every change from a link against its squares, links can't add photos, videos or portals, and Turn off ends a link at once.
- **Search:** on the Canvases page, across everything typed and every canvas title. Results open the canvas at that note.
- **Account (Settings):** change password, download all your data as JSON, log out on all devices, delete the account.
- **Install:** the site has an app icon and manifest, so "Add to Home screen" on a phone opens it like an app.
- **Limits against abuse:** 10 sign-ups an hour and 30 sign-in attempts per 10 minutes from one network; after 10 wrong passwords for an account from one network, that network waits 15 minutes (others, including the owner, aren't affected); up to 3 reset or confirmation emails an hour per address; the bot check once it's switched on.
- **Email confirmation:** sign-up sends a link. Sharing waits until it's opened, so throwaway accounts can't publish links. Resetting a password by email also confirms it. Accounts from before this change count as confirmed.

## Not built yet

- Sign in with ChatGPT: OpenAI requires approval for hosted apps (interest form linked in `docs/PLAN.md`).
- Handwriting recognition and semantic search.
- Share-link visitors see a stroke once it's finished, not while it's drawn (the room would need each link's squares to filter the stream).
