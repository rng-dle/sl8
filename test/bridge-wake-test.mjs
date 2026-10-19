// The bridge end to end against `wrangler dev` plus the fake provider: agent names fixed at consent, a message to an AI wakes
// that AI's routine (an alert copied onto its inbox, token reused), a message to "josh" pushes to his phone, every message is
// mirrored onto the "Claude Bridge Log" canvas, and nothing an AI places overlaps what is already on a canvas. Exits non-zero on failure.
import { createHash, randomBytes } from 'node:crypto';
const B = process.argv[2] || 'http://127.0.0.1:8787';
const F = process.argv[3] || 'http://127.0.0.1:8788';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const rnd = () => Math.random().toString(36).slice(2, 8);
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class User {
  jar = new Map(); ip = ip();
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async json(path, body, method = body ? 'POST' : 'GET') {
    const res = await fetch(B + path, { method, headers: { cookie: this.cookie(), 'cf-connecting-ip': this.ip, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); this.jar.set(k, v); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  async form(fields) {
    const res = await fetch(B + '/alerts', { method: 'POST', redirect: 'manual', headers: { cookie: this.cookie(), 'cf-connecting-ip': this.ip, 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: new URLSearchParams(fields) });
    return { status: res.status, html: await res.text() };
  }
}
const josh = new User();
await josh.json('/api/signup', { email: `josh-${rnd()}@example.com`, password: 'correcthorse' });
const log = (await josh.json('/api/notes', { title: 'Claude Bridge Log' })).body.note;
const work = (await josh.json('/api/notes', { title: 'Work' })).body.note;

const REDIRECT = 'http://127.0.0.1:9999/callback';
async function connect(user, clientName, agent) {
  const reg = await (await fetch(B + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = `?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=${challenge}&code_challenge_method=S256&scope=canvas:read`;
  const page = await (await fetch(B + '/authorize' + q, { headers: { cookie: user.cookie() } })).text();
  const r = await fetch(B + '/authorize', { method: 'POST', redirect: 'manual', headers: { cookie: user.cookie(), 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: new URLSearchParams({ q, decision: 'allow', write: '1', edit: '1', ...(agent !== undefined && { agent }) }) });
  const code = new URL(r.headers.get('location') || '', REDIRECT).searchParams.get('code');
  const tok = await (await fetch(B + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }) })).json();
  return { token: tok.access_token, page };
}
let rpcId = 0;
async function call(token, name, args = {}) {
  const res = await fetch(B + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await res.text();
  const data = raw.includes('data:') ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))[0] : JSON.parse(raw || 'null');
  const text = data?.result?.content?.[0]?.text ?? JSON.stringify(data);
  let j = null; try { j = JSON.parse(text); } catch {}
  return { text, j, isError: !!data?.result?.isError || !!data?.error };
}

const jet = await connect(josh, 'Jet', 'jet');
ok(/name="agent" value="jet"/.test(jet.page), 'the consent screen suggests an agent name from the app name', jet.page.slice(0, 300));
const max = await connect(josh, 'Max desktop', 'max');
const anon = await connect(josh, 'Nameless', '');
ok(jet.token && max.token && anon.token, 'three connections approved');
ok((await call(anon.token, 'bridge_send', { to: 'jet', body: 'hi' })).isError, 'a connection without an agent name cannot use the bridge');

// Wake Jet: one routine alert, then "Also use for this" copies it onto Jet's inbox without re-pasting the token.
const trig = 'trig_' + rnd() + rnd();
const routineToken = 'sk-ant-oat01-' + randomBytes(24).toString('hex');
let p = await josh.form({ action: 'add', note_id: work.id, kind: 'routine', label: 'Wake Jet', url: `${F}/routines/${trig}/fire`, token: routineToken, cooldown: '1' });
ok(/Alert added/.test(p.html), 'a routine alert is added on a canvas');
const hookId = (p.html.match(/name="id" value="([^"]+)"/) || [])[1];
ok(p.html.includes('value="bridge:jet"') && p.html.includes('value="bridge:josh"'), 'the alerts page offers AI inboxes');
p = await josh.form({ action: 'copy', id: hookId, note_id: 'bridge:jet' });
ok(/Alert added/.test(p.html) && /messages to jet/.test(p.html), 'it can be copied onto Jet\'s inbox', p.html.slice(0, 300));
p = await josh.form({ action: 'add', note_id: 'bridge:josh', kind: 'push', label: 'My phone', cooldown: '1' });
const topic = (p.html.match(/subscribe to the topic (thinksl8-[a-z0-9]{20})/) || [])[1];
ok(!!topic, 'messages to josh can push to his phone');

const fires = async () => (await (await fetch(`${F}/__fires?id=${trig}`)).json());
let r = await call(max.token, 'bridge_send', { to: 'jet', kind: 'task', body: 'Review PR 21 and tell me what to fix' });
ok(!r.isError && r.j?.needs_reply === true, 'Max sends Jet a task', r.text);
const thread = r.j?.thread;
let f = [];
for (let i = 0; i < 40 && !f.length; i++) { await sleep(150); f = await fires(); }
ok(f.length === 1 && f[0].auth === 'Bearer ' + routineToken && f[0].body.text.includes('bridge_check') && f[0].body.text.includes('max'), 'the message wakes Jet\'s routine with its token', JSON.stringify(f));
r = await call(jet.token, 'bridge_check');
ok(r.j?.unread === 1 && r.j.messages[0].from === 'max' && r.j.messages[0].body.includes('PR 21'), 'Jet reads it', r.text);
r = await call(jet.token, 'bridge_send', { to: 'max,josh', kind: 'result', thread, body: 'Two fixes needed: rename x, add test y. Josh: nothing to decide.' });
ok(!r.isError && Array.isArray(r.j?.to) && r.j.to.length === 2, 'Jet replies to Max and Josh at once', r.text);
let pushes = [];
for (let i = 0; i < 40 && !pushes.length; i++) { await sleep(150); pushes = await (await fetch(`${F}/__pushes?topic=${topic}`)).json(); }
ok(pushes.length === 1 && pushes[0].message.includes('jet'), 'Josh gets a phone push', JSON.stringify(pushes));
r = await call(max.token, 'bridge_check');
ok(r.j?.unread === 1 && r.j.stand_down === true, 'Max gets the result and is told to stand down', r.text);
r = await call(max.token, 'bridge_agents');
ok(/"agent":"josh"/.test(r.text) && /"agent":"jet"/.test(r.text), 'bridge_agents lists who is on the bridge', r.text);
await sleep(400);
const items = (await josh.json(`/api/notes/${log.id}`)).body.items.filter((i) => i.kind === 'text');
ok(items.length === 2 && items.some((i) => i.text.includes('PR 21')), 'messages are mirrored onto the Claude Bridge Log canvas', JSON.stringify(items.map((i) => i.text.slice(0, 40))));

// Never overlap.
const H = (it) => { const per = Math.max(6, Math.floor((it.w - 12) / (it.s * 0.62))); return it.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0) * it.s * 1.5 + 16; };
const overlaps = (list) => list.some((a, i) => list.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + H(b) && b.y < a.y + H(a)));
ok(!overlaps(items), 'mirrored entries do not overlap');
const long = 'A long entry. '.repeat(80);
r = await call(jet.token, 'add_note', { canvas_id: work.id, text: long, x: 0, y: 0 });
const first = r.j?.added;
r = await call(jet.token, 'add_note', { canvas_id: work.id, text: 'Placed on top on purpose', x: 10, y: 20 });
r = await call(jet.token, 'add_note', { canvas_id: work.id, text: 'And another' });
let w = (await josh.json(`/api/notes/${work.id}`)).body.items.filter((i) => i.kind === 'text');
ok(w.length === 3 && !overlaps(w), 'a note asked to go on top of another is moved below it', JSON.stringify(w.map((i) => [i.x, i.y])));
r = await call(jet.token, 'update_item', { canvas_id: work.id, item_id: first, text: long + long });
w = (await josh.json(`/api/notes/${work.id}`)).body.items.filter((i) => i.kind === 'text');
ok(!r.isError && !overlaps(w), 'when a note grows, what is below it moves down', JSON.stringify(w.map((i) => [i.x, i.y])));
r = await call(jet.token, 'update_item', { canvas_id: work.id, item_id: first, y: (w.find((i) => i.id !== first)?.y ?? 0) + 5 });
w = (await josh.json(`/api/notes/${work.id}`)).body.items.filter((i) => i.kind === 'text');
ok(!r.isError && !overlaps(w), 'a move onto another note lands below it instead', JSON.stringify(w.map((i) => [i.x, i.y])));

process.exit(failed ? 1 : 0);
