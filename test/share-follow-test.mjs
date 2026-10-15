// Share links that open linked canvases, against `wrangler dev`: what a link can reach through portals, what it can't,
// view vs edit, chosen squares refused, turning off. Exits non-zero on failure.
const B = process.argv[2] || 'http://127.0.0.1:8787';
const FAKE = process.env.FAKE || 'http://127.0.0.1:8788';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const rnd = () => Math.random().toString(36).slice(2, 8);
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
class Client {
  jar = new Map(); ip = ip();
  async json(path, { method = 'GET', body } = {}) {
    const headers = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'cf-connecting-ip': this.ip };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(B + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); this.jar.set(k, v); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}
const text = (id, x = 10, y = 10) => ({ id, kind: 'text', t: 1, x, y, w: 200, s: 17, c: 'ink', text: id });
const portal = (id, target) => ({ id, kind: 'portal', t: 1, x: 0, y: 100, w: 240, h: 132, target });
const mk = async (c, title, items) => {
  const { body: { note } } = await c.json('/api/notes', { method: 'POST', body: { title } });
  await c.json(`/api/notes/${note.id}/ops`, { method: 'POST', body: { ops: items(note.id).map((put) => ({ put })) } });
  return note.id;
};

const owner = new Client(), anon = new Client(), stranger = new Client();
const email = `follow-${rnd()}@example.com`;
await owner.json('/api/signup', { method: 'POST', body: { email, password: 'correcthorse' } });
await new Promise((r) => setTimeout(r, 300));
const mail = (await (await fetch(`${FAKE}/__emails?to=${encodeURIComponent(email)}`)).json()).find((m) => /Confirm/.test(m.subject));
await owner.json('/api/verify', { method: 'POST', body: { token: mail.text.match(/token=([a-f0-9]{64})/)[1] } });
await stranger.json('/api/signup', { method: 'POST', body: { email: `follow-${rnd()}@example.com`, password: 'correcthorse' } });

// hub -> B -> D, hub -> C; X is the owner's private canvas nobody links to; Y belongs to someone else but the hub points at it
const Y = await mk(stranger, 'Not yours', () => [text('y1')]);
const X = await mk(owner, 'Private', () => [text('x1')]);
const D = await mk(owner, 'Deep', () => [text('d1')]);
const C = await mk(owner, 'Sibling', () => [text('c1')]);
const Bn = await mk(owner, 'Middle', () => [text('b1'), portal('p-d', D)]);
const A = await mk(owner, 'Hub', () => [text('a1'), portal('p-b', Bn), portal('p-c', C), portal('p-y', Y), portal('p-gone', '00000000-0000-4000-8000-000000000000')]);

let r = await owner.json(`/api/notes/${A}/shares`, { method: 'POST', body: { mode: 'read', area: '*', follow: true } });
ok(r.status === 201 && r.body.share.follow === true, 'a view link can be made to open linked canvases');
const view = r.body.share.token, V = `/api/shared/${view}`;

r = await anon.json(V);
ok(r.body.share?.follow === true && r.body.share.root === A, 'the link says it follows portals and which canvas is its root');
const reach = Object.keys(r.body.share?.canvases || {}).sort().join(',');
ok(reach === [A, Bn, C, D].sort().join(','), 'it lists the hub and everything reachable through portals, and nothing else', reach);
ok(r.body.share.canvases[Bn] === 'Middle', 'portal titles come with it');

r = await anon.json(`${V}/c/${Bn}`);
ok(r.status === 200 && r.body.note.title === 'Middle' && r.body.items.some((i) => i.id === 'b1'), 'a linked canvas opens through the link');
r = await anon.json(`${V}/c/${D}`);
ok(r.status === 200 && r.body.items.some((i) => i.id === 'd1'), 'a canvas two portals away opens too');
r = await anon.json(`${V}/c/${X}`);
ok(r.status === 404, "the owner's unlinked canvas stays private");
r = await anon.json(`${V}/c/${Y}`);
ok(r.status === 404, "a portal to someone else's canvas opens nothing");
r = await anon.json(`${V}/c/not-a-canvas`);
ok(r.status === 404, 'an unknown canvas is refused');
r = await anon.json(`${V}/c/${Bn}`, { method: 'POST' });
ok(r.status !== 200, 'nothing can be posted to a canvas path');
r = await anon.json(`${V}/c/${Bn}/ops`, { method: 'POST', body: { ops: [{ put: text('hack') }] } });
ok(r.status === 403, 'a view link cannot edit a linked canvas');

// a link made without it does not follow
r = await owner.json(`/api/notes/${A}/shares`, { method: 'POST', body: { mode: 'read', area: '*' } });
const plain = r.body.share.token;
ok(r.body.share.follow === false, 'following is off unless chosen');
r = await anon.json(`/api/shared/${plain}/c/${Bn}`);
ok(r.status === 404, 'an ordinary link opens nothing but its own canvas');
r = await anon.json(`/api/shared/${plain}`);
ok(!r.body.share.follow && !r.body.share.canvases, 'and does not even list linked canvases');

// chosen squares can't follow
r = await owner.json(`/api/notes/${A}/shares`, { method: 'POST', body: { mode: 'read', area: ['3/0/0'], follow: true } });
ok(r.status === 400, 'chosen squares cannot follow portals');

// edit links
r = await owner.json(`/api/notes/${A}/shares`, { method: 'POST', body: { mode: 'write', area: '*', follow: true } });
const edit = r.body.share.token, E = `/api/shared/${edit}`;
r = await anon.json(`${E}/c/${Bn}/ops`, { method: 'POST', body: { ops: [{ put: text('guest-note', 50, 50) }] } });
ok(r.status === 200, 'an edit link can change a linked canvas');
r = await owner.json(`/api/notes/${Bn}`);
ok(r.body.items.some((i) => i.id === 'guest-note'), "and the change lands in the owner's canvas");
r = await anon.json(`${E}/c/${X}/ops`, { method: 'POST', body: { ops: [{ put: text('hack') }] } });
ok(r.status === 404, 'but not in a canvas it cannot reach');
r = await anon.json(`${E}/c/${Bn}?since=${Date.now() - 60000}`);
ok(r.status === 200 && r.body.items.some((i) => i.id === 'guest-note'), 'catching up on a linked canvas works');

// the list says which links follow; turning off ends them
r = await owner.json(`/api/notes/${A}/shares`);
ok(r.body.shares.find((s) => s.token === view)?.follow === true && r.body.shares.find((s) => s.token === plain)?.follow === false, 'the share list shows which links open linked canvases');
await owner.json(`/api/notes/${A}/shares/${view}`, { method: 'DELETE' });
r = await anon.json(`${V}/c/${Bn}`);
ok(r.status === 404, 'turning a link off ends access to its linked canvases');
await owner.json(`/api/notes/${Bn}`, { method: 'DELETE' });
r = await anon.json(E);
ok(!(Bn in (r.body.share?.canvases || {})), 'a deleted canvas drops out of the link');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
