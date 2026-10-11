// Account basics against `wrangler dev` + test/fake-provider.mjs: password reset by email, change password,
// sign out everywhere, export, search, delete account, rate limits, 404. Exits non-zero on failure.
const B = process.argv[2] || 'http://127.0.0.1:8787';
const FAKE = process.env.FAKE || 'http://127.0.0.1:8788';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const rnd = () => Math.random().toString(36).slice(2, 8);
const ipOf = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;

class Client {
  jar = new Map();
  ip = ipOf(); // each client looks like its own network, so per-address limits don't leak between runs
  async req(path, { method = 'GET', body } = {}) {
    const headers = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'cf-connecting-ip': this.ip };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(B + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      if (/Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return res;
  }
  async json(path, opts) { const r = await this.req(path, opts); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; }
}
const inbox = async (to) => (await (await fetch(`${FAKE}/__emails?to=${encodeURIComponent(to)}`)).json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (id, t, body) => ({ put: { id, kind: 'text', t, x: 0, y: t * 40, w: 320, s: 17, c: 'ink', text: body } });

const email = `acct-${rnd()}@example.com`, PW = 'correcthorse', PW2 = 'batterystaple';
const a = new Client(), phone = new Client(), stranger = new Client();
await a.json('/api/signup', { method: 'POST', body: { email, password: PW } });
await phone.json('/api/login', { method: 'POST', body: { email, password: PW } });

// password reset
let r = await stranger.json('/api/password/forgot', { method: 'POST', body: { email: `nobody-${rnd()}@example.com` } });
ok(r.status === 200, 'reset request for an unknown email gets the same reply (no account probing)');
r = await stranger.json('/api/password/forgot', { method: 'POST', body: { email: email.toUpperCase() } });
await wait(300);
let mail = await inbox(email);
ok(r.status === 200 && mail.length === 1, 'reset email is sent for a real account', JSON.stringify(r.body));
const link = mail[0]?.text.match(/https?:\/\/\S+\/reset\?token=([a-f0-9]{64})/);
ok(!!link && /expires in 1 hour/.test(mail[0].text), 'email contains a one-time reset link');
const token = link?.[1];
r = await stranger.json('/api/password/reset', { method: 'POST', body: { token: 'f'.repeat(64), password: PW2 } });
ok(r.status === 400, 'a made-up token is refused');
r = await stranger.json('/api/password/reset', { method: 'POST', body: { token, password: 'short' } });
ok(r.status === 400 && /8 characters/.test(r.body.error), 'a short new password is refused');
const resetter = new Client();
r = await resetter.json('/api/password/reset', { method: 'POST', body: { token, password: PW2 } });
ok(r.status === 200 && resetter.jar.has('sid'), 'reset sets the new password and signs in');
ok((await a.json('/api/me')).status === 401 && (await phone.json('/api/me')).status === 401, 'reset signs out every other device');
ok((await stranger.json('/api/password/reset', { method: 'POST', body: { token, password: 'anotherpass1' } })).status === 400, 'a reset link works only once');
ok((await new Client().json('/api/login', { method: 'POST', body: { email, password: PW } })).status === 401, 'the old password stops working');
await a.json('/api/login', { method: 'POST', body: { email, password: PW2 } });
ok((await a.json('/api/me')).status === 200, 'the new password works');

// per-email and per-network limits on reset requests
const sizeBefore = (await inbox(email)).length;
const flood = new Client();
for (let i = 0; i < 4; i++) await flood.json('/api/password/forgot', { method: 'POST', body: { email } });
await wait(300);
ok((await inbox(email)).length - sizeBefore <= 3, 'no more than 3 reset emails per hour for one address');
r = await flood.json('/api/password/forgot', { method: 'POST', body: { email } });
r = await flood.json('/api/password/forgot', { method: 'POST', body: { email } });
ok(r.status === 429, 'too many reset requests from one network are refused');

// change password
await phone.json('/api/login', { method: 'POST', body: { email, password: PW2 } });
r = await a.json('/api/password/change', { method: 'POST', body: { current: 'wrongwrong', password: PW } });
ok(r.status === 400 && /current password/.test(r.body.error), 'changing password needs the current one');
r = await a.json('/api/password/change', { method: 'POST', body: { current: PW2, password: PW } });
ok(r.status === 200 && (await a.json('/api/me')).status === 200, 'password change keeps this device signed in');
ok((await phone.json('/api/me')).status === 401, 'password change signs out other devices');

// sign out everywhere
await phone.json('/api/login', { method: 'POST', body: { email, password: PW } });
await a.json('/api/logout-all', { method: 'POST' });
ok((await a.json('/api/me')).status === 401 && (await phone.json('/api/me')).status === 401, 'log out on all devices ends every session');
await a.json('/api/login', { method: 'POST', body: { email, password: PW } });

// export and search
const note = (await a.json('/api/notes', { method: 'POST', body: { title: 'Pricing ideas' } })).body.note;
await a.json(`/api/notes/${note.id}/ops`, { method: 'POST', body: { ops: [
  text('t1', 1, 'Student pricing at nine dollars a month'),
  text('t2', 2, 'Ask the textile client about invoices'),
  { put: { id: 's1', kind: 'stroke', t: 3, c: 'ink', w: 3, pr: true, p: [0, 0, 0.5, 5, 5, 0.6] } },
] } });
r = await a.json('/api/export');
ok(/attachment; filename="thinksl8-\d{4}-\d\d-\d\d\.json"/.test(r.headers.get('content-disposition')), 'export downloads as a dated file');
const canvas = r.body.canvases?.find((c) => c.id === note.id);
ok(r.body.account?.email === email && canvas?.items.length === 3 && canvas.items.some((i) => i.kind === 'stroke'), 'export has the account, canvases, text and ink', JSON.stringify(r.body).slice(0, 200));
ok(!JSON.stringify(r.body).includes('pw_hash'), 'export contains no password data');

r = await a.json('/api/search?q=' + encodeURIComponent('pric'));
ok(r.body.results.some((x) => x.id === 't1' && x.snippet.includes('\u0001')), 'search matches word starts and marks the match', JSON.stringify(r.body));
ok(r.body.canvases.some((c) => c.id === note.id), 'search matches canvas titles');
r = await a.json('/api/search?q=' + encodeURIComponent('textile invoices'));
ok(r.body.results.length === 1 && r.body.results[0].id === 't2', 'every word must match');
r = await a.json('/api/search?q=' + encodeURIComponent('100%_'));
ok(r.status === 200, 'search copes with symbols');
const other = new Client();
await other.json('/api/signup', { method: 'POST', body: { email: `other-${rnd()}@example.com`, password: PW } });
r = await other.json('/api/search?q=pricing');
ok(r.body.results.length === 0 && r.body.canvases.length === 0, "search never returns another account's notes");

// delete account
r = await a.json('/api/account/delete', { method: 'POST', body: { password: 'wrongwrong' } });
ok(r.status === 400 && (await a.json('/api/me')).status === 200, 'a wrong password deletes nothing');
r = await a.json('/api/account/delete', { method: 'POST', body: { password: PW } });
ok(r.status === 200 && !a.jar.has('sid'), 'account deletion signs out');
ok((await new Client().json('/api/login', { method: 'POST', body: { email, password: PW } })).status === 401, 'the deleted account can no longer sign in');
r = await new Client().json('/api/signup', { method: 'POST', body: { email, password: PW } });
const fresh = r.status === 200;
ok(fresh, 'the email can be used again for a new account');
ok(fresh && (await (async () => { const c = new Client(); await c.json('/api/login', { method: 'POST', body: { email, password: PW } }); return (await c.json('/api/notes')).body.notes.length === 0; })()), 'nothing from the deleted account carries over');
ok((await other.json('/api/me')).status === 200, 'other accounts are untouched');

// network limits and 404
const bot = new Client();
let codes = [];
for (let i = 0; i < 11; i++) codes.push((await bot.json('/api/signup', { method: 'POST', body: { email: `bot-${rnd()}${i}@example.com`, password: PW } })).status);
ok(codes.slice(0, 10).every((c) => c === 200) && codes[10] === 429, 'more than 10 signups an hour from one network are refused', codes.join(','));
const nf = await fetch(B + '/no-such-page');
ok(nf.status === 404 && (await nf.text()).includes("This page isn't here"), 'unknown pages show the 404 page');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
