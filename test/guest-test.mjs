// Guest demo against `wrangler dev`: start, isolation, guards, caps, rate limit, logout wipe, upgrade.
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
const inbox = async (to, about = 'Reset') => (await (await fetch(`${FAKE}/__emails?to=${encodeURIComponent(to)}`)).json()).filter((m) => m.subject.includes(about));

const PW = 'correcthorse';
const g = new Client();
let r = await g.json('/api/guest', { method: 'POST', body: {} });
ok(r.status === 200 && r.body.guest === true, 'guest login starts a demo session');
const me = (await g.json('/api/me')).body;
ok(me.guest === true && me.onboarded === true && me.email === null && me.guestUntil > Date.now(), '/api/me says guest, skips setup, hides the fake address');
const list = (await g.json('/api/notes')).body.notes;
ok(list.length === 7 && list[0].title === 'Start here' && me.lastNoteId === list[0].id, 'seven demo canvases, "Start here" first');
const start = (await g.json('/api/notes/' + list[0].id)).body;
const targets = start.items.filter((i) => i.kind === 'portal').map((i) => i.target);
ok(targets.length === 6 && targets.every((t) => list.some((n) => n.id === t)), 'portals point at the guest\'s own canvases');
const g2 = new Client(), other = (await g2.json('/api/guest', { method: 'POST', body: {} })).body;
const list2 = (await g2.json('/api/notes')).body.notes;
ok(!list2.some((n) => list.some((m) => m.id === n.id)), 'each guest gets their own copy');
ok((await g2.json('/api/notes/' + list[0].id)).status === 404, 'a guest cannot open another guest\'s canvas');

// guards
const gx = new Client(); await gx.json('/api/guest', { method: 'POST', body: {} });
const blocked = [
  ['/api/ai', 'GET'], ['/api/files', 'POST'], ['/api/market', 'POST'], ['/api/account/delete', 'POST'], ['/api/password/change', 'POST'],
  [`/api/notes/${list2[0].id}/shares`, 'POST'],
];
for (const [path, method] of blocked) {
  const res = await gx.json(path, { method, body: {} });
  ok(res.status === 403 && res.body.kind === 'guest', `guest blocked: ${method} ${path.replace(/[0-9a-f-]{36}/, ':id')}`, JSON.stringify(res));
}
let made = 0;
for (let i = 0; i < 8; i++) made += (await gx.json('/api/notes', { method: 'POST', body: { title: 'x' } })).status === 201 ? 1 : 0;
ok(made === 5, 'guests can hold 12 canvases (7 demo + 5 own)', String(made));
ok((await gx.json('/api/notes/' + list2[0].id + '/ops', { method: 'POST', body: { ops: [{ put: { id: 'n1', kind: 'text', t: 1, x: 0, y: 0, w: 320, s: 17, c: 'ink', text: 'mine' } }] } })).status === 200, 'guests can edit the demo');

// rate limit: 5 demo sessions an hour per network
const spam = new Client(); const codes = [];
for (let i = 0; i < 6; i++) codes.push((await spam.json('/api/guest', { method: 'POST', body: {} })).status);
ok(codes.join() === '200,200,200,200,200,429', 'demo sessions are limited to 5 an hour per network', codes.join());

// logging out wipes the demo
const bye = new Client(); await bye.json('/api/guest', { method: 'POST', body: {} });
const byeNote = (await bye.json('/api/notes')).body.notes[0].id;
const cookies = new Map(bye.jar);
await bye.json('/api/logout', { method: 'POST' });
bye.jar = cookies; // replay the old cookie: the session and the account are gone
ok((await bye.json('/api/notes/' + byeNote)).status === 401, 'logging out of a demo deletes it');

// upgrade keeps the canvases
const up = new Client(); await up.json('/api/guest', { method: 'POST', body: {} });
const before = (await up.json('/api/notes')).body.notes.length;
const mail = `guest-up-${rnd()}@example.com`;
r = await up.json('/api/guest/upgrade', { method: 'POST', body: { email: mail, password: PW } });
ok(r.status === 200, 'a guest can turn the demo into an account');
const after = (await up.json('/api/me')).body;
ok(after.guest === false && after.email === mail && (await up.json('/api/notes')).body.notes.length === before, 'the upgraded account keeps its canvases and is no longer a guest');
const back = new Client();
ok((await back.json('/api/login', { method: 'POST', body: { email: mail, password: PW } })).status === 200, 'and can log in with the new password');
ok((await new Client().json('/api/guest/upgrade', { method: 'POST', body: { email: mail, password: PW } })).status === 401, 'upgrade needs a session');
ok((await back.json('/api/guest/upgrade', { method: 'POST', body: { email: mail, password: PW } })).status === 400, 'a full account cannot "upgrade"');

// the fake address can't be used to log in
ok((await new Client().json('/api/login', { method: 'POST', body: { email: `guest-${crypto.randomUUID()}@guest.invalid`, password: PW } })).status === 401, 'guest addresses are not login accounts');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
