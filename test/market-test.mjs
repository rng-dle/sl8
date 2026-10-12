// The marketplace against `wrangler dev`: browsing signed out, publishing from a canvas and from JSON (private things left
// out), using a template (fresh ids, arrows re-pointed), using a theme on a canvas (photo kept), taking down. Exits non-zero on failure.
const B = process.argv[2] || 'http://127.0.0.1:8787';
const FAKE = process.env.FAKE || 'http://127.0.0.1:8788';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const rnd = () => Math.random().toString(36).slice(2, 8);
class Client {
  jar = new Map();
  ip = `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
  async json(path, { method = 'GET', body } = {}) {
    const headers = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'cf-connecting-ip': this.ip };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(B + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); this.jar.set(k, v); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}
const text = (id, x, y) => ({ id, kind: 'text', t: 1, x, y, w: 200, s: 17, c: 'ink', text: id });
async function verified(c) {
  const email = `market-${rnd()}@example.com`;
  await c.json('/api/signup', { method: 'POST', body: { email, password: 'correcthorse' } });
  await new Promise((r) => setTimeout(r, 300));
  const mail = (await (await fetch(`${FAKE}/__emails?to=${encodeURIComponent(email)}`)).json()).find((m) => /Confirm/.test(m.subject));
  await c.json('/api/verify', { method: 'POST', body: { token: mail.text.match(/token=([a-f0-9]{64})/)[1] } });
}

const anon = new Client(), author = new Client(), user = new Client(), unverified = new Client();
let r = await anon.json('/api/market');
ok(r.status === 200 && r.body.signedIn === false, 'browsing works signed out');
const official = r.body.items.filter((e) => e.official);
ok(official.some((e) => e.kind === 'template') && official.some((e) => e.kind === 'theme'), 'the official shelf has templates and themes');
ok((await anon.json('/api/market/tpl-project-plan/use', { method: 'POST' })).status === 401, 'using needs an account');
ok((await anon.json('/api/market', { method: 'POST', body: { name: 'x', items: [text('a', 0, 0)] } })).status === 401, 'publishing needs an account');

await unverified.json('/api/signup', { method: 'POST', body: { email: `market-${rnd()}@example.com`, password: 'correcthorse' } });
r = await unverified.json('/api/market', { method: 'POST', body: { name: 'Spam', items: [text('a', 0, 0)] } });
ok(r.status === 403 && r.body.kind === 'verify', 'publishing waits for a confirmed email');

await verified(author);
const { body: { note } } = await author.json('/api/notes', { method: 'POST', body: { title: 'Kanban', style: { theme: 'paper', pattern: 'grid', image: '00000000-0000-0000-0000-000000000000' } } });
await author.json(`/api/notes/${note.id}/ops`, { method: 'POST', body: { ops: [
  { put: text('todo', 0, 0) }, { put: text('done', 300, 0) },
  { put: { id: 'arrow', kind: 'conn', t: 2, a: 'todo', b: 'done', c: 'ink' } },
  { put: { id: 'line', kind: 'stroke', t: 3, c: 'blue', w: 3, p: [0, 100, 0.5, 200, 120, 0.5] } },
  { put: { id: 'door', kind: 'portal', t: 4, x: 0, y: 300, w: 200, h: 120, target: note.id } },
] } });
r = await author.json('/api/market', { method: 'POST', body: { noteId: note.id, name: 'Kanban board', description: 'Two columns' } });
ok(r.status === 201 && r.body.id, 'publish a canvas as a template', JSON.stringify(r.body));
const tplId = r.body.id;
let mine = (await author.json('/api/market')).body.items.find((e) => e.id === tplId);
ok(mine?.mine && !mine.official && mine.kind === 'template', 'it shows as yours');
ok(mine?.data.items.length === 4 && !mine.data.items.some((it) => it.kind === 'portal'), 'portals stay private', JSON.stringify(mine?.data.items.map((i) => i.kind)));
ok(mine?.data.style.theme === 'paper' && !mine.data.style.image, 'the look is copied without the background photo', JSON.stringify(mine?.data.style));
ok((await author.json('/api/market', { method: 'POST', body: { noteId: 'not-mine', name: 'x' } })).status === 404, "can't publish someone else's canvas");

r = await author.json('/api/market', { method: 'POST', body: { name: 'From JSON', style: { pattern: 'lines' }, items: [
  text('a', 0, 0), { id: 'bad', kind: 'conn', t: 1, a: 'a', b: 'missing', c: 'ink' }, { id: 'pic', kind: 'image', t: 1, x: 0, y: 0, w: 10, h: 10, file: '00000000-0000-0000-0000-000000000000' },
] } });
const jsonTpl = (await anon.json('/api/market')).body.items.find((e) => e.id === r.body.id);
ok(r.status === 201 && jsonTpl?.data.items.length === 1, 'publish from JSON keeps only notes, drawings and complete arrows', JSON.stringify(jsonTpl?.data.items));
ok((await author.json('/api/market', { method: 'POST', body: { name: 'Empty', items: [{ id: 'x', kind: 'image' }] } })).status === 400, 'an empty template is refused');
ok((await author.json('/api/market', { method: 'POST', body: { name: '  ', items: [text('a', 0, 0)] } })).status === 400, 'a name is required');

await verified(user);
r = await user.json(`/api/market/${tplId}/use`, { method: 'POST' });
ok(r.status === 201 && r.body.noteId, 'use a template');
let canvas = (await user.json(`/api/notes/${r.body.noteId}`)).body;
const conn = canvas.items?.find((it) => it.kind === 'conn'), ids = new Set(canvas.items?.map((it) => it.id));
ok(canvas.note?.title === 'Kanban board' && canvas.items.length === 4, 'the copy is a new canvas with everything in it', JSON.stringify(canvas.note));
ok(!ids.has('todo') && conn && ids.has(conn.a) && ids.has(conn.b), 'the copy has fresh ids and its arrow still connects');
ok(canvas.note?.style.theme === 'paper', 'the copy has the template look');
ok((await user.json(`/api/notes/${note.id}`)).status === 404, "using doesn't open the author's canvas");

const { body: { note: own } } = await user.json('/api/notes', { method: 'POST', body: { title: 'Mine', style: { image: '11111111-1111-1111-1111-111111111111', fit: 'cover', theme: 'light' } } });
r = await user.json('/api/market/theme-blueprint/use', { method: 'POST', body: { noteId: own.id } });
canvas = (await user.json(`/api/notes/${own.id}`)).body;
ok(r.status === 200 && canvas.note.style.theme === 'blueprint' && canvas.note.style.image === '11111111-1111-1111-1111-111111111111', 'a theme restyles a canvas and keeps its photo', JSON.stringify(canvas.note.style));
r = await user.json('/api/market/theme-midnight/use', { method: 'POST' });
canvas = (await user.json(`/api/notes/${r.body.noteId}`)).body;
ok(r.status === 201 && canvas.note.style.paper === '#0e0f14' && canvas.items.length === 0, 'a theme can start a new blank canvas');
ok((await user.json('/api/market/theme-midnight/use', { method: 'POST', body: { noteId: note.id } })).status === 404, "a theme can't touch someone else's canvas");

ok((await user.json(`/api/market/${tplId}`, { method: 'DELETE' })).status === 403, "can't take down someone else's template");
ok((await user.json('/api/market/tpl-project-plan', { method: 'DELETE' })).status === 403, "can't take down an official one");
ok((await author.json(`/api/market/${tplId}`, { method: 'DELETE' })).status === 200, 'the author can take it down');
ok(!(await anon.json('/api/market')).body.items.some((e) => e.id === tplId), "it's gone from the shelf");
ok((await user.json(`/api/market/${tplId}/use`, { method: 'POST' })).status === 404, 'using a taken-down template says so');

// a Spotify player is kept; anything that isn't a plain Spotify reference is refused
const { body: { note: music } } = await author.json('/api/notes', { method: 'POST', body: { title: 'Music' } });
await author.json(`/api/notes/${music.id}/ops`, { method: 'POST', body: { ops: [{ put: { id: 'song', kind: 'embed', t: 1, x: 0, y: 0, w: 360, h: 178, ref: `track/${'a'.repeat(22)}` } }] } });
await author.json(`/api/notes/${music.id}/ops`, { method: 'POST', body: { ops: [{ put: { id: 'evil', kind: 'embed', service: 'youtube', t: 2, x: 0, y: 0, w: 360, h: 178, ref: 'v/../../x' } }] } });
const kept = (await author.json(`/api/notes/${music.id}`)).body.items.map((it) => it.id);
ok(kept.includes('song') && !kept.includes('evil'), 'a Spotify player is saved and a bad reference is refused', JSON.stringify(kept));

const page = await fetch(B + '/market');
ok(page.status === 200 && /Marketplace/.test(await page.text()), 'the marketplace page is served');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
