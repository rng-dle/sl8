# ThinkSL8 v1.0 — audit, provider research and plan

Written 2026-10-11 against the product brief ("ThinkSL8: Master Product Vision & Implementation Brief").

## 1. What exists today

- **Stack:** one Cloudflare Worker (`sl8`) serving static pages from `public/` and a JSON API from `src/worker.js`; data in D1 (`sl8-db`). No framework, no build step.
- **Domains:** `thinksl8.com` and `sl8.nastaliq.co` both serve this Worker.
- **Auth:** email + password (PBKDF2, 100k iterations), 30-day HttpOnly session cookie, lockout after 10 failures, origin check on writes. Server-side isolation is tested (`smoke-test.sh`).
- **Canvas:** infinite canvas per note with pressure ink, highlighter, eraser, text boxes, pan/zoom, undo/redo, autosave with an offline queue. Light/dark follows the system.
- **Live data:** 6 accounts, 6 canvases, ~200 saved items. All of it is preserved; schema changes are additive only.
- **Deploy is broken:** production is still the 2026-10-08 build. GitHub pushes since then (the S Pen palm-rejection fix) never deployed. A stray `sl8-dev` Worker was created on 2026-10-09.

## 2. Provider research: can a hosted web app use a person's own AI account?

| Provider | Sign-in that grants AI usage? | Available to ThinkSL8 now? | v1 route |
|---|---|---|---|
| **OpenRouter** | Yes. OAuth PKCE returns a key owned by the user; usage comes from their OpenRouter account. Free `:free` models work with no credits (50 requests/day, 1,000/day once 10 credits are bought). | **Yes**, self-serve, no approval. | **First sign-in provider.** Gives access to OpenAI, Anthropic, Google and other models through one account. |
| **OpenAI (ChatGPT)** | Yes. "Sign in with ChatGPT" plan usage lets apps spend a Plus/Pro user's plan allowance (launched in partner preview, Sept–Oct 2026). | **No.** Open to open-source and locally run apps; "paid or remotely hosted" apps must complete an interest form and be approved. | Apply now. API key in Advanced meanwhile. Provider layer is ready to add it when approved. |
| **Anthropic (Claude)** | No. Using Claude Free/Pro/Max OAuth tokens in any other product violates Anthropic's Consumer Terms (Feb 2026). | No. | API key only (Advanced). |
| **Google (Gemini)** | No. Gemini API OAuth bills the *app's* Google Cloud project, not the user's Gemini subscription, and Google describes it as a testing setup. | Not as "your account". It would be ThinkSL8 paying, i.e. the future managed-AI decision. | API key only (Advanced). |
| **Hugging Face** | Yes. OAuth scope `inference-api` makes requests on the user's behalf. | Yes, self-serve. But free accounts now get no monthly inference credits. | Candidate second provider; not in v1. |

Sources: [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth), [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits.md), [Sign in with ChatGPT – plan usage](https://developers.openai.com/siwc/token-sharing-open-source), [Request a client ID](https://developers.openai.com/siwc/request-client-id), [The Register on Anthropic's ban](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546), [Gemini API OAuth](https://ai.google.dev/gemini-api/docs/oauth), [Hugging Face OAuth scopes](https://huggingface.co/docs/hub/oauth), [HF Inference pricing](https://huggingface.co/docs/inference-providers/pricing).

**Consequence for the connect screen:** v1 shows OpenRouter as the one sign-in option. ChatGPT, Claude and Gemini appear only under Advanced → API key, labelled with what they actually are. No button leads to a flow that doesn't work.

## 3. v1.0 scope and order

Each step ships on its own and keeps existing notes working.

0. **Unblock.** Fix the deploy pipeline (Josh, in the Cloudflare dashboard). Rename to ThinkSL8 and make `thinksl8.com` canonical; `sl8.nastaliq.co` redirects there. Ship the pending "Draw with finger" toggle.
1. **Canvas completion.**
   - Select tool: drag a box to select ink and text together; move, delete, and undo them.
   - Double-tap or double-click empty space to start typing.
   - Canvas-first: signing in opens your last canvas, and the canvas list becomes a switcher.
   - Appearance: theme (system/light/dark) and background (dots/grid/lines/plain).
2. **AI backend.**
   - Provider layer (`src/ai.js`): one interface per provider for listing models and streaming chat.
     - OpenRouter, OpenAI and Gemini share the OpenAI-compatible shape; Anthropic gets its own small adapter.
   - Connections: one per user, key encrypted with AES-GCM using a Worker secret, never sent to the browser.
   - OpenRouter OAuth PKCE, with the verifier in an HttpOnly cookie.
   - Capability check before calling a connection "connected": the key must list models.
   - Retrieval: SQLite FTS5 index over typed text, ranked by relevance, then topped up with recently edited text. Each snippet is dated so "last week" works.
   - Scope enforced on the server: selection, current canvas, or all canvases.
   - Usage cap per user per day; output length cap per request.
   - Error mapping: 401 → reconnect needed, 402 → no credits, 429 → rate limited, model gone → choose another.
3. **AI UI.**
   - Settings → AI: connect, every state the brief lists, model picker, access scope with a disclosure, disconnect.
   - Settings → AI → Advanced connections → Use an API key.
   - In the canvas, an AI panel that asks about this canvas, plus Summarize, Make a plan and Develop on a selection.
   - Answers stream in with numbered sources that pan to the original text.
   - Nothing reaches the canvas until you press "Add to canvas", so suggestions never silently become actions.
4. **Onboarding and the infinity reveal.**
   - After signup: start blank or with a sample canvas that doubles as the tour, then an optional AI step. Both can be skipped.
   - The infinity sign draws itself and opens into the canvas.
   - Short version on later sign-ins; tap to skip; no motion for reduced-motion users.
5. **Verification.**
   - Extended smoke test: AI isolation, encryption at rest, scope enforcement, and connection error states against a local stand-in provider.
   - Pen and finger tests, then a browser run of the full journey.
   - Real inference is verified on production with a real OpenRouter account.

## 4. Known limits in v1 (stated in the product, not hidden)

- AI reads typed text only. Handwriting is invisible to it until handwriting recognition is added.
- Retrieval is keyword-based (FTS5), not semantic. It misses paraphrases; embeddings come in Phase 3.
- Disconnect deletes ThinkSL8's copy of the key. Revoking the key itself happens on OpenRouter's keys page, which the UI links to.
- No password reset yet (needs an email provider). No sharing or collaboration (brief section 10 defers it).

## 5. Needs from Josh

1. **Deploy:** in Cloudflare → Workers & Pages → `sl8` → Settings → Builds, connect `rng-dle/sl8` (branch `main`, deploy command `npx wrangler deploy`). Delete the stray `sl8-dev` Worker.
2. **Secret:** in `sl8` → Settings → Variables and Secrets, add a secret named `KEY_ENC_SECRET` with a random value of 32+ characters (a password manager's generator is fine). Without it, AI connections are refused rather than stored unencrypted.
3. **OpenAI:** submit the Sign in with ChatGPT interest form (https://openai.com/form/sign-in-with-chatgpt-interest/) for plan usage in a hosted app.
4. **Testing:** an OpenRouter account to try the real connection once it's live.
