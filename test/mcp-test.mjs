// The MCP connector against `wrangler dev` (plus the fake provider for the confirmation email): OAuth (register, consent, PKCE token),
// read-only vs write access, tools, and isolation between accounts. Exits non-zero on failure.
import { createHash, randomBytes } from 'node:crypto';
const B = process.argv[2] || 'http://127.0.0.1:8787';
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}${!cond && extra ? `\n       ${extra}` : ''}`); if (!cond) failed++; };
const rnd = () => Math.random().toString(36).slice(2, 8);
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
class User {
  jar = new Map(); ip = ip();
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async json(path, body, method = body ? 'POST' : 'GET') {
    const res = await fetch(B + path, { method, headers: { cookie: this.cookie(), 'cf-connecting-ip': this.ip, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); this.jar.set(k, v); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}
const alice = new User(), bob = new User();
for (const [u, n] of [[alice, 'alice'], [bob, 'bob']]) await u.json('/api/signup', { email: `${n}-${rnd()}@example.com`, password: 'correcthorse' });
const { body: { note } } = await alice.json('/api/notes', { title: 'Plans' });
const bobNote = (await bob.json('/api/notes', { title: 'Bobs secret' })).body.note;
await alice.json(`/api/notes/${note.id}/ops`, { ops: [{ put: { id: 'n1', kind: 'text', t: 1, x: 0, y: 0, w: 200, s: 17, c: 'ink', text: 'Book the venue for the launch party' } }] });
await bob.json(`/api/notes/${bobNote.id}/ops`, { ops: [{ put: { id: 'b1', kind: 'text', t: 1, x: 0, y: 0, w: 200, s: 17, c: 'ink', text: 'launch codes are hunter2' } }] });

const REDIRECT = 'http://127.0.0.1:9999/callback';
const reg = await (await fetch(B + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test AI', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
ok(reg.client_id, 'an app can register itself', JSON.stringify(reg));
const meta = await (await fetch(B + '/.well-known/oauth-authorization-server')).json();
ok(meta.token_endpoint && meta.authorization_endpoint, 'authorization server metadata is published', JSON.stringify(meta));

async function connect(user, write) {
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = `?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${challenge}&code_challenge_method=S256&scope=canvas:read`;
  let r = await fetch(B + '/authorize' + q);
  if (r.status !== 401) return { error: `signed-out authorize gave ${r.status}` };
  r = await fetch(B + '/authorize' + q, { headers: { cookie: user.cookie() } });
  const html = await r.text();
  if (r.status !== 200 || !/Test AI/.test(html)) return { error: `consent page ${r.status}` };
  const form = new URLSearchParams({ q, decision: 'allow', ...(write && { write: '1' }) });
  const bad = await fetch(B + '/authorize', { method: 'POST', redirect: 'manual', headers: { cookie: user.cookie(), 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: form });
  if (bad.status !== 403) return { error: `cross-site consent was not refused (${bad.status})` };
  r = await fetch(B + '/authorize', { method: 'POST', redirect: 'manual', headers: { cookie: user.cookie(), 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: form });
  const loc = r.headers.get('location') || '';
  const code = new URL(loc, REDIRECT).searchParams.get('code');
  if (!code || !loc.startsWith(REDIRECT) || !loc.includes('state=xyz')) return { error: `no code in ${r.status} ${loc}` };
  const tok = await (await fetch(B + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }) })).json();
  return tok.access_token ? { token: tok.access_token } : { error: JSON.stringify(tok) };
}
let rpcId = 0;
async function rpc(token, method, params) {
  const res = await fetch(B + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const raw = await res.text();
  const data = raw.startsWith('event:') || raw.includes('\ndata:') || raw.startsWith('data:') ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))[0] : JSON.parse(raw || 'null');
  return { status: res.status, data };
}
const call = async (token, name, args) => { const r = await rpc(token, 'tools/call', { name, arguments: args }); return { ...r, text: r.data?.result?.content?.[0]?.text ?? JSON.stringify(r.data), isError: !!r.data?.result?.isError || !!r.data?.error }; };

ok((await rpc(null, 'tools/list', {})).status === 401, 'the connector refuses requests without a token');
const ro = await connect(alice, false);
ok(ro.token, 'a read-only connection can be approved with PKCE', ro.error);
const bobTok = await connect(bob, false);

const init = await rpc(ro.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
ok(init.status === 200 && init.data?.result?.serverInfo?.name === 'thinksl8', 'MCP initialize works', JSON.stringify(init.data));
const list = await rpc(ro.token, 'tools/list', {});
const names = (list.data?.result?.tools || []).map((t) => t.name).sort().join(',');
ok(names === 'add_note,add_voice_note,create_canvas,get_voice_note,list_canvases,read_canvas,search,set_voice_transcript', 'the eight tools are listed', names);

let r = await call(ro.token, 'list_canvases', {});
ok(!r.isError && r.text.includes('Plans') && !r.text.includes('Bobs secret'), 'list_canvases shows only your canvases', r.text);
r = await call(ro.token, 'read_canvas', { canvas_id: note.id });
ok(!r.isError && r.text.includes('Book the venue'), 'read_canvas returns typed notes', r.text);
r = await call(ro.token, 'read_canvas', { canvas_id: bobNote.id });
ok(r.isError, "read_canvas refuses someone else's canvas");
r = await call(ro.token, 'search', { query: 'launch' });
ok(r.text.includes('Book the venue') && !r.text.includes('hunter2'), 'search finds your notes and never anyone elses', r.text);
r = await call(ro.token, 'add_voice_note', { canvas_id: note.id, audio_base64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(40).fill(1)]).toString('base64') });
ok(r.isError && /read-only/.test(r.text), 'a read-only connection cannot add recordings', r.text);
r = await call(ro.token, 'create_canvas', { title: 'Should not exist' });
ok(r.isError && /read-only/.test(r.text), 'a read-only connection cannot create canvases', r.text);
r = await call(ro.token, 'add_note', { canvas_id: note.id, text: 'should not land' });
ok(r.isError && /read-only/.test(r.text), 'a read-only connection cannot add typed notes', r.text);

const rw = await connect(alice, true); // approving again replaces the earlier grant for this app, so the read-only checks come first
ok(rw.token, 'a connection with write access can be approved', rw.error);
const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(40).fill(1)]).toString('base64');
r = await call(rw.token, 'add_voice_note', { canvas_id: note.id, audio_base64: audio, transcript: 'Call the caterer on Monday', seconds: 4.2 });
ok(!r.isError && r.text.includes('added'), 'a write connection can add a recording with a transcript', r.text);
const added = JSON.parse(r.text).added;
r = await call(rw.token, 'add_voice_note', { canvas_id: note.id, audio_base64: Buffer.from('not audio at all').toString('base64') });
ok(r.isError, 'unrecognised audio is refused');
r = await call(rw.token, 'add_voice_note', { canvas_id: bobNote.id, audio_base64: audio });
ok(r.isError, "cannot add to someone else's canvas");
const mine = (await alice.json(`/api/notes/${note.id}`)).body.items.find((i) => i.id === added);
ok(mine?.kind === 'voice' && mine.text === 'Call the caterer on Monday' && mine.dur === 4.2, 'the recording shows up on the canvas');
const file = await fetch(`${B}/api/files/${mine.file}`, { headers: { cookie: alice.cookie() } });
ok(file.status === 200 && file.headers.get('content-type') === 'video/webm', 'and its audio plays from the normal file route');

r = await call(rw.token, 'create_canvas', { title: '  Claude Bridge Log  ' });
ok(!r.isError && JSON.parse(r.text).title === 'Claude Bridge Log', 'a write connection can create a canvas', r.text);
const madeId = JSON.parse(r.text).id;
r = await call(rw.token, 'list_canvases', {});
ok(r.text.includes(madeId), 'the new canvas appears in list_canvases', r.text);
r = await call(bobTok.token, 'read_canvas', { canvas_id: madeId });
ok(r.isError, "someone else's token can't read the new canvas");
r = await call(rw.token, 'add_note', { canvas_id: madeId, text: 'first entry in a fresh canvas' });
ok(!r.isError, 'a note can be added to a canvas the connector created', r.text);
r = await call(rw.token, 'create_canvas', { title: '' });
ok(r.isError, 'an empty title is refused');
r = await call(rw.token, 'add_note', { canvas_id: note.id, text: '[ID 0001] hello from the other Claude\nsecond line' });
ok(!r.isError && r.text.includes('added'), 'a write connection can add a typed note', r.text);
const noteId = JSON.parse(r.text).added;
const typed = (await alice.json(`/api/notes/${note.id}`)).body.items.find((i) => i.id === noteId);
ok(typed?.kind === 'text' && typed.text.startsWith('[ID 0001]') && typed.y > 0, 'the typed note lands below the existing notes', JSON.stringify(typed));
r = await call(rw.token, 'add_note', { canvas_id: note.id, text: 'placed here', x: 500, y: 40 });
const placed = (await alice.json(`/api/notes/${note.id}`)).body.items.find((i) => i.id === JSON.parse(r.text).added);
ok(placed?.x === 500 && placed?.y === 40, 'a typed note can be placed at x and y', r.text);
r = await call(rw.token, 'read_canvas', { canvas_id: note.id });
ok(r.text.includes('hello from the other Claude'), 'read_canvas returns the note that was added');
r = await call(rw.token, 'add_note', { canvas_id: bobNote.id, text: 'intruder' });
ok(r.isError, "cannot add a typed note to someone else's canvas");
r = await call(rw.token, 'add_note', { canvas_id: note.id, text: '' });
ok(r.isError, 'an empty note is refused');

r = await call(rw.token, 'set_voice_transcript', { canvas_id: note.id, item_id: added, transcript: 'Call the caterer on Tuesday' });
ok(!r.isError, 'a transcript can be replaced', r.text);
r = await call(rw.token, 'get_voice_note', { canvas_id: note.id, item_id: added, include_audio: true });
const blocks = (await rpc(rw.token, 'tools/call', { name: 'get_voice_note', arguments: { canvas_id: note.id, item_id: added, include_audio: true } })).data?.result?.content || [];
ok(blocks[0]?.text.includes('Tuesday') && blocks[1]?.type === 'audio' && blocks[1].data === audio, 'get_voice_note returns the transcript and the audio');
r = await call(rw.token, 'search', { query: 'caterer' });
ok(r.text.includes('Tuesday'), 'search finds voice transcripts');
r = await call(bobTok.token, 'get_voice_note', { canvas_id: note.id, item_id: added });
ok(r.isError, "someone else's token can't read your recording");

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
