// Canvas alerts against `wrangler dev --test-scheduled` plus the fake provider: the /alerts page, routine fires from
// connector writes (match filter, cooldown, the scheduled catch-up), email alerts, and isolation. Exits non-zero on failure.
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
  async form(fields, origin = B) {
    const res = await fetch(B + '/alerts', { method: 'POST', redirect: 'manual', headers: { cookie: this.cookie(), 'cf-connecting-ip': this.ip, 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(fields) });
    return { status: res.status, html: await res.text() };
  }
}
const alice = new User(), bob = new User();
const aliceEmail = `alice-${rnd()}@example.com`;
await alice.json('/api/signup', { email: aliceEmail, password: 'correcthorse' });
await bob.json('/api/signup', { email: `bob-${rnd()}@example.com`, password: 'correcthorse' });
const bridge = (await alice.json('/api/notes', { title: 'Claude Bridge Log' })).body.note;
const other = (await alice.json('/api/notes', { title: 'Shopping' })).body.note;

// connector access for alice (write)
const REDIRECT = 'http://127.0.0.1:9999/callback';
const reg = await (await fetch(B + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Alerts test AI', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
async function connect(user) {
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = `?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=${challenge}&code_challenge_method=S256&scope=canvas:read`;
  const r = await fetch(B + '/authorize', { method: 'POST', redirect: 'manual', headers: { cookie: user.cookie(), 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: new URLSearchParams({ q, decision: 'allow', write: '1', edit: '1' }) });
  const code = new URL(r.headers.get('location') || '', REDIRECT).searchParams.get('code');
  const tok = await (await fetch(B + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }) })).json();
  return tok.access_token;
}
let rpcId = 0;
async function call(token, name, args) {
  const res = await fetch(B + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await res.text();
  const data = raw.includes('data:') ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))[0] : JSON.parse(raw || 'null');
  return { text: data?.result?.content?.[0]?.text ?? JSON.stringify(data), isError: !!data?.result?.isError || !!data?.error };
}
const token = await connect(alice);
ok(!!token, 'alice connects with write and edit access');

const trig = 'trig_' + rnd() + rnd();
const fireUrl = `${F}/routines/${trig}/fire`;
const routineToken = 'sk-ant-oat01-' + randomBytes(24).toString('hex');
const fires = async () => (await (await fetch(`${F}/__fires?id=${trig}`)).json());
const waitFires = async (n) => { for (let i = 0; i < 40; i++) { const f = await fires(); if (f.length >= n) return f; await sleep(150); } return fires(); };
const emails = async () => (await (await fetch(`${F}/__emails?to=${encodeURIComponent(aliceEmail)}`)).json()).filter((m) => /^ThinkSL8: /.test(m.subject));

// the page
let r = await fetch(B + '/alerts');
ok(r.status === 401, 'the alerts page asks you to sign in first');
let p = await alice.form({ action: 'add', note_id: bridge.id, kind: 'routine', url: fireUrl, token: routineToken, cooldown: '2' }, 'https://evil.example');
ok(p.status === 403, 'a cross-site form post is refused');
p = await alice.form({ action: 'add', note_id: bridge.id, kind: 'routine', url: 'https://evil.example/fire', token: routineToken, cooldown: '2' });
ok(/looks wrong/.test(p.html), 'a routine URL that is not a routine trigger is refused');
p = await bob.form({ action: 'add', note_id: bridge.id, kind: 'routine', url: fireUrl, token: routineToken, cooldown: '2' });
ok(/Pick one of your canvases/.test(p.html), "you can't put an alert on someone else's canvas");
p = await alice.form({ action: 'add', note_id: bridge.id, kind: 'routine', label: 'Wake claude-ai', url: fireUrl, token: routineToken, match: 'TO: claude-ai', cooldown: '2' });
ok(/Alert added/.test(p.html) && /Wake claude-ai/.test(p.html), 'alice adds a routine alert', p.html.slice(0, 300));
ok(!p.html.includes(routineToken), 'the routine token is never shown back');
const bobPage = await (await fetch(B + '/alerts', { headers: { cookie: bob.cookie() } })).text();
ok(!bobPage.includes('Wake claude-ai'), "bob doesn't see alice's alerts");

// fires
await call(token, 'add_note', { canvas_id: bridge.id, text: '## [ID 0001] FROM: org-claude | TO: claude-ai | STATUS: open\nPlease check the leads file.' });
let f = await waitFires(1);
ok(f.length === 1 && f[0].auth === 'Bearer ' + routineToken && f[0].body.text.includes('[ID 0001]') && f[0].body.text.includes(bridge.id), 'a matching AI entry wakes the routine with its token and the entry', JSON.stringify(f));
await call(token, 'add_note', { canvas_id: bridge.id, text: '## [ID 0002] FROM: claude-ai | TO: org-claude | STATUS: open\nYour turn.' });
await sleep(800);
ok((await fires()).length === 1, 'an entry that does not match the filter does not wake it');
await call(token, 'add_note', { canvas_id: other.id, text: 'TO: claude-ai on another canvas' });
await sleep(500);
ok((await fires()).length === 1, 'writes to other canvases do not wake it');
await alice.json(`/api/notes/${bridge.id}/ops`, { ops: [{ put: { id: 'own1', kind: 'text', t: Date.now(), x: 0, y: 900, w: 300, s: 17, c: 'ink', text: 'TO: claude-ai from Josh in the app' } }] });
await sleep(500);
ok((await fires()).length === 1, "the owner's own edits in the app don't wake it");
await call(token, 'add_note', { canvas_id: bridge.id, text: '## [ID 0003] FROM: org-claude | TO: claude-ai | STATUS: done\nDone.' });
await sleep(600);
ok((await fires()).length === 1, 'inside the cooldown the next match waits');
let page = await (await fetch(B + '/alerts', { headers: { cookie: alice.cookie() } })).text();
ok(/one waiting/.test(page) && /woke the routine/.test(page), 'the page shows the last result and the waiting alert');
await sleep(2200);
await fetch(B + '/__scheduled?cron=' + encodeURIComponent('*/5 * * * *'));
f = await waitFires(2);
ok(f.length === 2 && f[1].body.text.includes('[ID 0003]'), 'the scheduled run sends what waited out the cooldown', JSON.stringify(f.map((x) => x.body.text)));
await fetch(B + '/__scheduled?cron=' + encodeURIComponent('*/5 * * * *'));
await sleep(500);
ok((await fires()).length === 2, 'and does not send it twice');

const hookId = (page.match(/name="id" value="([^"]+)"/) || [])[1];
p = await alice.form({ action: 'test', id: hookId });
ok(/Test: woke the routine/.test(p.html) && (await waitFires(3)).length === 3, 'the test button fires it');
p = await bob.form({ action: 'test', id: hookId });
ok(/No such alert/.test(p.html), "bob can't fire alice's alert");
p = await bob.form({ action: 'delete', id: hookId });
await sleep(2200);
await call(token, 'add_note', { canvas_id: bridge.id, text: 'TO: claude-ai still there?' });
ok((await waitFires(4)).length === 4, "bob can't remove alice's alert");

// email alerts
p = await alice.form({ action: 'add', note_id: other.id, kind: 'email', label: 'Mail me', cooldown: '1' });
ok(/Alert added/.test(p.html), 'alice adds an email alert');
await call(token, 'add_note', { canvas_id: other.id, text: 'Milk and eggs\nsecond line' });
let mails = [];
for (let i = 0; i < 40 && !mails.length; i++) { await sleep(150); mails = await emails(); }
ok(mails.length === 1 && mails[0].subject === 'ThinkSL8: Milk and eggs' && mails[0].text.includes(`/note?id=${other.id}`), 'an AI write emails the owner with a link', JSON.stringify(mails));

// removing
page = await (await fetch(B + '/alerts', { headers: { cookie: alice.cookie() } })).text();
for (const id of [...page.matchAll(/name="id" value="([^"]+)"/g)].map((m) => m[1])) await alice.form({ action: 'delete', id });
page = await (await fetch(B + '/alerts', { headers: { cookie: alice.cookie() } })).text();
ok(/No alerts yet/.test(page), 'alerts can be removed');
await sleep(2200);
await call(token, 'add_note', { canvas_id: bridge.id, text: 'TO: claude-ai after removal' });
await sleep(800);
ok((await fires()).length === 4, 'a removed alert stays quiet');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
