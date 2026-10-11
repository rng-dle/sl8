// Sharing and sync against `wrangler dev`: links for the whole canvas or dot-grid areas, view vs edit,
// area checks on writes, files through links, catching up on changes and deletes, turning links off. Exits non-zero on failure.
const B = process.argv[2] || 'http://127.0.0.1:8787';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const rnd = () => Math.random().toString(36).slice(2, 8);
const ipOf = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
class Client {
  jar = new Map();
  ip = ipOf();
  async json(path, { method = 'GET', body } = {}) {
    const headers = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'cf-connecting-ip': this.ip };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(B + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); this.jar.set(k, v); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}
const text = (id, x, y) => ({ id, kind: 'text', t: 1, x, y, w: 200, s: 17, c: 'ink', text: id });
const ids = (r) => (r.body.items || []).map((i) => i.id).sort().join(',');
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

const owner = new Client(), anon = new Client(), other = new Client();
await owner.json('/api/signup', { method: 'POST', body: { email: `share-${rnd()}@example.com`, password: 'correcthorse' } });
await other.json('/api/signup', { method: 'POST', body: { email: `share-${rnd()}@example.com`, password: 'correcthorse' } });
const { body: { note } } = await owner.json('/api/notes', { method: 'POST', body: { title: 'Shared' } });
const N = `/api/notes/${note.id}`;

// "3/0/0" is the level-3 square (24 * 2^3 = 192 units) at the origin: x and y in [0, 192)
const up = await fetch(B + '/api/files', { method: 'POST', headers: { cookie: `sid=${owner.jar.get('sid')}`, 'content-type': 'image/png' }, body: PNG });
const file = (await up.json()).id;
await owner.json(N + '/ops', { method: 'POST', body: { ops: [
  { put: text('in1', 10, 10) }, { put: text('in2', 150, 100) }, { put: text('out1', 500, 10) }, { put: text('neg', -5, 10) },
  { put: { id: 's-in', kind: 'stroke', t: 2, c: 'ink', w: 3, p: [20, 20, 0.5, 900, 900, 0.5] } }, // starts inside, so it belongs inside
  { put: { id: 'c-in', kind: 'conn', t: 3, a: 'in1', b: 'in2', c: 'ink' } }, { put: { id: 'c-out', kind: 'conn', t: 3, a: 'in1', b: 'out1', c: 'ink' } },
  { put: { id: 'img-in', kind: 'image', t: 4, file, x: 40, y: 40, w: 10, h: 10 } },
] } });
const t0 = (await owner.json(N)).body.now;
ok(typeof t0 === 'number', 'canvas load says the server time, for catching up later');

// owner creates links; strangers can't
let r = await other.json(N + '/shares', { method: 'POST', body: { mode: 'read', area: '*' } });
ok(r.status === 404, "another account can't share someone else's canvas");
r = await owner.json(N + '/shares', { method: 'POST', body: { mode: 'read', area: ['3/0/0', 'nope'] } });
ok(r.status === 400, 'a malformed area is refused');
const view = (await owner.json(N + '/shares', { method: 'POST', body: { mode: 'read', area: '*' } })).body.share;
const edit = (await owner.json(N + '/shares', { method: 'POST', body: { mode: 'write', area: ['3/0/0', '3/0/0'] } })).body.share;
ok(/^[a-f0-9]{64}$/.test(view.token) && edit.area.length === 1, 'links are created (duplicate squares merged)');
r = await owner.json(N + '/shares');
ok(r.body.shares.length === 2, 'owner lists the links');

// whole-canvas view link
const V = `/api/shared/${view.token}`, E = `/api/shared/${edit.token}`;
r = await anon.json(V);
ok(r.status === 200 && r.body.items.length === 8 && r.body.note.title === 'Shared' && r.body.share.mode === 'read', 'view link opens the whole canvas without an account');
r = await anon.json(V + '/ops', { method: 'POST', body: { ops: [{ put: text('x', 1, 1) }] } });
ok(r.status === 403, "view link can't change anything");

// area edit link sees only its squares; arrows need both ends inside
r = await anon.json(E);
ok(ids(r) === 'c-in,img-in,in1,in2,s-in', 'area link shows only items that start in its squares', ids(r));
r = await anon.json(E + '/ops', { method: 'POST', body: { ops: [
  { put: text('new-in', 100, 100) }, { put: text('new-out', 300, 300) }, { put: { ...text('in2', 400, 100) } },
  { del: 'out1' }, { del: 'in1' }, { put: { id: 'img2', kind: 'image', t: 5, file, x: 50, y: 50, w: 10, h: 10 } },
  { put: { id: 'c-new', kind: 'conn', t: 6, a: 'new-in', b: 'out1', c: 'ink' } },
] } });
ok(r.status === 200 && [...r.body.rejected].sort().join(',') === 'c-new,img2,in2,new-out,out1', 'edits outside the area are refused, inside ones saved', JSON.stringify(r.body));
r = await owner.json(N);
const got = ids(r);
ok(got.includes('new-in') && !got.includes('new-out') && !got.includes('in1') && got.includes('out1') && r.body.items.find((i) => i.id === 'in2').x === 150, 'owner sees exactly the allowed edits', got);

// catching up: changes and deletes since t0
r = await owner.json(`${N}?since=${t0}`);
ok(r.body.items.some((i) => i.id === 'new-in') && r.body.gone.includes('in1'), 'another device catches up on new items and deletes', JSON.stringify(r.body).slice(0, 300));
await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: text('in1', 10, 10) }] } }); // undo brings it back
r = await owner.json(`${N}?since=${t0}`);
ok(!r.body.gone.includes('in1') && r.body.items.some((i) => i.id === 'in1'), 'an item that came back is not reported deleted');
await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: text('new-in', 700, 700) }] } }); // owner moves it out of the area
r = await anon.json(`${E}?since=${t0}`);
ok(r.body.gone.includes('new-in') && !r.body.items.some((i) => i.id === 'new-in'), 'an item moved out of the area disappears for the area link');
r = await owner.json(`${N}?since=${Date.now() - 3 * 864e5}`);
ok(r.body.reload === true, 'a device away for days reloads instead of catching up');

// files through links
let f = await fetch(`${B}${E}/files/${file}`);
ok(f.status === 200 && f.headers.get('content-type') === 'image/png', 'a photo in the area loads through the link');
await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: { id: 'img-in', kind: 'image', t: 4, file, x: 900, y: 40, w: 10, h: 10 } }] } });
f = await fetch(`${B}${E}/files/${file}`);
ok(f.status === 404, "a photo outside the area doesn't load through the link");

// turning a link off
await owner.json(`${N}/shares/${view.token}`, { method: 'DELETE' });
r = await anon.json(V);
ok(r.status === 404, 'a turned-off link stops working');
await owner.json(N, { method: 'DELETE' });
r = await anon.json(E);
ok(r.status === 404, 'deleting the canvas ends its links');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
