// End-to-end AI checks against `wrangler dev` + test/fake-provider.mjs (see README). Exits non-zero on the first failure.
import { execSync } from 'node:child_process';

const B = process.argv[2] || 'http://127.0.0.1:8787';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const sql = (q) => JSON.parse(execSync(`npx wrangler d1 execute sl8-db --local --json --command "${q}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString())[0].results;

const RUN_IP = `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`; // this run's own address for rate limits
class Client {
  jar = new Map();
  async req(path, { method = 'GET', body, follow = true } = {}) {
    const headers = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'cf-connecting-ip': RUN_IP };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(B + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}), redirect: follow ? 'follow' : 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const [k, v] = kv.split('=');
      if (/Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return res;
  }
  async json(path, opts) { const r = await this.req(path, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; }
  async ask(body) {
    const r = await this.req('/api/ai/ask', { method: 'POST', body: { tz: 'Asia/Karachi', ...body } });
    if (!r.headers.get('content-type')?.includes('ndjson')) return { status: r.status, ...(await r.json()) };
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    return {
      status: r.status,
      sources: lines.find((l) => l.t === 'sources')?.sources || [],
      text: lines.filter((l) => l.t === 'delta').map((l) => l.text).join(''),
      error: lines.find((l) => l.t === 'error'),
      done: lines.some((l) => l.t === 'done'),
    };
  }
}
const rnd = () => Math.random().toString(36).slice(2, 8);
const text = (id, t, body) => ({ put: { id, kind: 'text', t, x: 0, y: t * 40, w: 320, s: 17, c: 'ink', text: body } });

const a = new Client(), b = new Client();
await a.json('/api/signup', { method: 'POST', body: { email: `ai-a-${rnd()}@example.com`, password: 'correcthorse' } });
await b.json('/api/signup', { method: 'POST', body: { email: `ai-b-${rnd()}@example.com`, password: 'correcthorse' } });

const me = (await a.json('/api/me')).body;
ok(me.onboarded === false && me.lastNoteId === null, 'new account is not onboarded and has no canvas');
const sample = (await a.json('/api/notes', { method: 'POST', body: { sample: true } })).body.note;
const sampleItems = (await a.json(`/api/notes/${sample.id}`)).body.items;
ok(sample.title === 'Start here' && sampleItems.length === 7, 'sample canvas is created with its 7 notes');
await a.json('/api/me/onboarded', { method: 'POST' });
ok((await a.json('/api/me')).body.onboarded === true, 'onboarding is remembered');

const note = (await a.json('/api/notes', { method: 'POST', body: { title: 'Launch' } })).body.note;
await a.json(`/api/notes/${note.id}/ops`, { method: 'POST', body: { ops: [
  text('p1', 1, 'Pricing: start at $12 per month, annual plan two months free.'),
  text('p2', 2, 'Onboarding should take under a minute.'),
  text('p3', 3, 'Ask Sara about the launch date.'),
] } });

let r = await a.json('/api/ai');
ok(r.body.available === true && r.body.connection === null, 'AI is available and starts disconnected');
ok((await a.ask({ scope: 'canvas', noteId: note.id, question: 'hi' })).kind === 'none', 'asking before connecting explains what to do');

r = await a.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: 'sk-bad-0000000000' } });
ok(r.status === 400 && /didn't accept/.test(r.body.error), 'a key the provider rejects is not saved', JSON.stringify(r.body));
ok((await a.json('/api/ai')).body.connection === null, 'still disconnected after a rejected key');

const KEY = 'sk-test-secretvalue1234';
r = await a.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: KEY } });
ok(r.status === 200 && r.body.connection.model === 'gpt-test' && r.body.connection.hint === '1234', 'OpenAI key connects after a live model check', JSON.stringify(r.body));
ok(r.body.models.map((m) => m.id).join() === 'gpt-test', 'non-chat models (embeddings, audio) are filtered out', JSON.stringify(r.body.models));
ok(!JSON.stringify((await a.json('/api/ai')).body).includes('secretvalue'), 'the key is never returned to the browser');
const stored = sql('SELECT secret FROM ai_connections');
ok(stored.length >= 1 && stored.every((s) => !s.secret.includes('secretvalue')), 'the key is encrypted in the database');

let ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'What did I write about pricing?' });
ok(ans.done && ans.text.includes('$12 per month'), 'answer is grounded in the saved canvas text', JSON.stringify(ans));
ok(ans.sources.some((s) => s.id === 'p1' && s.title === 'Launch'), 'sources point back to the notes used');

ans = await a.ask({ scope: 'all', question: 'pricing?' });
ok(ans.status === 403 && ans.kind === 'scope', 'reading all canvases is refused until allowed');
await a.json('/api/ai', { method: 'PATCH', body: { scope: 'selection' } });
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'pricing?' });
ok(ans.status === 403, 'with "selected items only", the whole canvas is refused');
ans = await a.ask({ scope: 'selection', noteId: note.id, itemIds: ['p3'], action: 'summarize' });
ok(ans.done && ans.sources.length === 1 && ans.sources[0].id === 'p3', 'selection scope sends only the selected note', JSON.stringify(ans.sources));
await a.json('/api/ai', { method: 'PATCH', body: { scope: 'all' } });
ans = await a.ask({ scope: 'all', question: 'What did I write about pricing?' });
ok(ans.done && ans.sources.some((s) => s.id === 'p1'), 'all-canvases scope works once allowed');

// big canvas: too much text to send whole, so keyword search must find the old note
const big = (await a.json('/api/notes', { method: 'POST', body: { title: 'Big' } })).body.note;
const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12);
await a.json(`/api/notes/${big.id}/ops`, { method: 'POST', body: { ops: [text('z1', 1, 'The zebra crossing idea for the onboarding flow.'), ...Array.from({ length: 35 }, (_, i) => text('f' + i, i + 2, filler + i))] } });
ans = await a.ask({ scope: 'canvas', noteId: big.id, question: 'What was the zebra idea?' });
ok(ans.sources[0]?.id === 'z1', 'keyword search finds an older note on a large canvas', JSON.stringify(ans.sources.slice(0, 2)));
await a.json(`/api/notes/${big.id}/ops`, { method: 'POST', body: { ops: [text('z1', 1, 'Renamed: the crosswalk idea.')] } });
await new Promise((r) => setTimeout(r, 5));
await a.json(`/api/notes/${big.id}/ops`, { method: 'POST', body: { ops: [text('f34', 36, filler + 'touched')] } }); // newest edit, so recency can't mask a stale index
const hit = async (q) => (await a.ask({ scope: 'canvas', noteId: big.id, question: q })).sources[0]?.id === 'z1';
ok(!(await hit('zebra')) && (await hit('crosswalk')), 'search index follows edits');
await a.json(`/api/notes/${big.id}/ops`, { method: 'POST', body: { ops: [{ del: 'z1' }] } });
ok(!(await hit('crosswalk')), 'search index follows deletes');

// another account can't reach this account's canvases or connection
ok((await b.json('/api/ai')).body.connection === null, 'other account has no access to this connection');
await b.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: 'sk-test-otheruser9999' } });
ans = await b.ask({ scope: 'canvas', noteId: note.id, question: 'pricing?' });
ok(ans.status === 404, "other account can't ask about this account's canvas");
ans = await b.ask({ scope: 'all', question: 'pricing?' });
ok(ans.status === 403 || !ans.sources?.length, "other account's all-canvas search never returns this account's notes");

// providers and failure states
r = await a.json('/api/ai/key', { method: 'POST', body: { provider: 'anthropic', key: 'sk-ant-test-abcdefgh' } });
ok(r.body.connection?.model === 'claude-sonnet-test', 'Anthropic key connects');
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'What did I write about pricing?' });
ok(ans.done && ans.text.includes('$12'), 'Anthropic answers stream through', JSON.stringify(ans));
ok((await a.json('/api/ai')).body.connection.scope === 'all', 'reconnecting keeps the access choice');
r = await a.json('/api/ai/key', { method: 'POST', body: { provider: 'gemini', key: 'AIza-test-abcdefgh' } });
ok(r.body.connection?.model === 'gemini-flash-test', 'Gemini key connects with a chat model', JSON.stringify(r.body));

await a.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: 'sk-broke-abcdefgh' } });
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'pricing?' });
ok(ans.error?.kind === 'credits', 'no credits is explained', JSON.stringify(ans));
ok((await a.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: 'sk-revoked-abcdefgh' } })).status === 400, 'a revoked key cannot connect');

// key revoked on the provider's side while connected
const FLIP = `sk-test-flip-${rnd()}`;
await a.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: FLIP } });
await fetch(new URL('/__revoke', process.env.FAKE || 'http://127.0.0.1:8788'), { method: 'POST', body: JSON.stringify({ key: FLIP }) });
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'pricing?' });
ok(ans.error?.kind === 'auth', 'a revoked connection is reported while answering', JSON.stringify(ans));
ok((await a.json('/api/ai')).body.connection.status === 'reconnect', 'the connection is marked as needing reconnection');
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'pricing?' });
ok(ans.status === 409 && ans.kind === 'auth', 'further questions ask the user to reconnect instead of failing silently');

// OpenRouter sign-in (OAuth PKCE)
let res = await a.req(`/api/ai/openrouter/start?return=${encodeURIComponent(`/note?id=${note.id}`)}`, { follow: false });
const authUrl = new URL(res.headers.get('location'));
ok(res.status === 302 && authUrl.searchParams.get('code_challenge_method') === 'S256' && a.jar.has('ai_pkce'), 'sign-in sends the user to the provider with a PKCE challenge');
res = await fetch(authUrl, { redirect: 'manual' });
const callback = new URL(res.headers.get('location'));
res = await a.req(callback.pathname + callback.search, { follow: false });
ok(res.status === 302 && res.headers.get('location') === `/note?id=${note.id}&ai=connected`, 'callback exchanges the code and returns to the canvas', res.headers.get('location'));
r = await a.json('/api/ai');
ok(r.body.connection?.provider === 'openrouter' && r.body.connection.method === 'oauth' && r.body.connection.model.endsWith(':free'), 'OpenRouter connects by sign-in and picks a free model for a free account', JSON.stringify(r.body.connection));
ok(!a.jar.has('ai_pkce'), 'the one-time PKCE cookie is cleared');
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'What did I write about pricing?' });
ok(ans.done && ans.text.includes('$12'), 'answers work over the signed-in connection');

res = await a.req('/api/ai/openrouter/callback?code=x', { follow: false });
ok(res.headers.get('location') === '/settings?ai_error=expired', 'a callback without a started sign-in is refused');
await a.req('/api/ai/openrouter/start?return=//evil.example', { follow: false });
res = await a.req('/api/ai/openrouter/callback', { follow: false });
ok(res.headers.get('location') === '/settings?ai_error=cancelled', 'cancelling returns to Settings, and outside return addresses are ignored', res.headers.get('location'));
await a.req('/api/ai/openrouter/start', { follow: false });
a.jar.set('ai_pkce', 'tampered-verifier%7C%2Fsettings');
res = await a.req('/api/ai/openrouter/callback?code=stolen-code', { follow: false });
ok(res.headers.get('location') === '/settings?ai_error=exchange', 'a code without the matching verifier is rejected');

r = await a.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: 'sk-test-good-abcdefgh' } });
ok(r.body.connection?.status === 'ok', 'reconnecting clears the reconnect state');
const userA = sql(`SELECT user_id FROM ai_connections WHERE created_at = (SELECT max(created_at) FROM ai_connections)`)[0].user_id;
await a.json('/api/ai', { method: 'DELETE' });
ok((await a.json('/api/ai')).body.connection === null, 'disconnect removes the connection');
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'pricing?' });
ok(ans.status === 409 && ans.kind === 'none', 'after disconnecting, AI asks to connect again');

// daily cap
await a.json('/api/ai/key', { method: 'POST', body: { provider: 'openai', key: 'sk-test-cap-abcdefgh' } });
sql(`INSERT INTO ai_usage VALUES ('${userA}', '${new Date().toISOString().slice(0, 10)}', 200) ON CONFLICT (user_id, day) DO UPDATE SET n = 200`);
ans = await a.ask({ scope: 'canvas', noteId: note.id, question: 'pricing?' });
ok(ans.status === 429 && ans.kind === 'cap', "today's limit is enforced");

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
