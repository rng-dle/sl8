# ThinkSL8

Think without boundaries. An infinite canvas for typed, handwritten and drawn thoughts, with the user's own AI connected to what they've written. Live at https://thinksl8.com.

One Cloudflare Worker (`sl8`): static pages in `public/`, API in `src/worker.js`, AI in `src/ai.js`, data in D1 (`sl8-db`). No framework, no build step. Product brief, provider research and the v1 plan: [`docs/PLAN.md`](docs/PLAN.md).

## Deploy

Pushes to `main` deploy through Cloudflare Workers Builds (Workers & Pages → `sl8` → Settings → Builds, repo `rng-dle/sl8`, deploy command `npx wrangler deploy`). By hand, with Node 18+:

```
npm install && npx wrangler login && npx wrangler d1 migrations apply sl8-db --remote && npx wrangler deploy
```

AI connections need one secret, `KEY_ENC_SECRET` (any random string of 32+ characters), which encrypts users' provider keys. Set it in the dashboard (`sl8` → Settings → Variables and Secrets) or with `npx wrangler secret put KEY_ENC_SECRET`. Without it the app works and AI shows as unavailable. Changing it later disconnects everyone's AI, so set it once.

## Run and test locally

`.dev.vars` (git-ignored) holds the local secret and points AI calls at a stand-in provider, so nothing real is called:

```
printf 'KEY_ENC_SECRET="local-dev-only-secret-0123456789abcdef"\nAI_TEST_BASE="http://127.0.0.1:8788"\n' > .dev.vars
npx wrangler d1 migrations apply sl8-db --local
node test/fake-provider.mjs &
npx wrangler dev --port 8787 --local-upstream 127.0.0.1:8787
```

Then, in another terminal:

```
bash test/smoke-test.sh && node test/ai-test.mjs && python3 test/pen-test.py && python3 test/journey.py
```

- `smoke-test.sh`: accounts, saving, isolation between users, lockout, logout.
- `ai-test.mjs`: AI connections, encryption at rest, OpenRouter sign-in (PKCE), scopes, retrieval, every error state, the daily cap.
- `pen-test.py`: simulated S Pen with a resting palm, and the "Draw with finger" toggle.
- `journey.py`: the whole journey in a browser, from signup through setup, the reveal, writing, selecting, asking AI and reloading, to settings and a phone layout.

The Python tests need `pip install playwright && playwright install chromium`.

## How the AI works

- **Connecting:** "Continue with OpenRouter" is a real OAuth PKCE flow. OpenRouter returns a key owned by the user, billed to their OpenRouter account, with free models available. OpenAI, Anthropic and Gemini connect by API key under Settings → AI → Advanced. Keys are checked against the provider before saving, encrypted with AES-GCM and never sent to the browser.
- **Asking:** the server gathers typed text from the scope the user allows (selection, current canvas, or all canvases) and sends it with the question. When a scope has too much text to send whole, it uses SQLite FTS5 keyword search plus the most recent edits. Answers stream back with numbered sources that link to the original notes. "Add to canvas" is the only way an answer reaches the canvas, and Undo removes it.
- **Limits:** 200 AI requests per user per day. Handwriting isn't readable by the AI yet.

## Using it

- **Select tool (V):** drag a box to select ink and text, drag to move, Delete to remove. Double-tap or double-click empty space to write.
- **Pen (P), highlighter (H), eraser (E), text (T).** An S Pen's side button or a tablet pen's eraser end erases while held.
- **Fingers:** once a pen has been used on the device, fingers move the page. "Draw with finger", next to the pen colours, switches that back.
- **Desktop:** the wheel pans, Ctrl + wheel or a trackpad pinch zooms, and holding Space lets you drag. Ctrl+Z and Ctrl+Shift+Z undo and redo.
- **Appearance:** theme and canvas background in the ⋯ menu or Settings. The opening animation can be set to Full, Short or Off.
- **Saving:** changes save every second. Offline edits stay on the device and are sent when the connection returns.

## Not built yet

- Password reset and email verification (needs an email provider such as Resend).
- Signup spam protection (Cloudflare Turnstile).
- Sign in with ChatGPT: OpenAI requires approval for hosted apps (interest form linked in `docs/PLAN.md`).
- Handwriting recognition, semantic search, connections between notes, and sharing.
