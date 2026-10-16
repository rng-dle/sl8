// Voice recordings against `wrangler dev` (and the fake provider for the confirmation email): upload formats, voice items,
// transcripts, serving with byte ranges, and that share links can't add recordings. Exits non-zero on failure.
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
  upload(bytes, type) { return fetch(B + '/api/files', { method: 'POST', headers: { cookie: `sid=${this.jar.get('sid')}`, 'content-type': type, 'cf-connecting-ip': this.ip }, body: bytes }); }
}
const bytes = (...head) => Uint8Array.from([...head, ...new Array(64).fill(7)]);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3), OGG = bytes(...ascii('OggS')), MP3 = bytes(...ascii('ID3')), WAV = bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')), M4A = bytes(0, 0, 0, 24, ...ascii('ftypM4A '));

const owner = new Client(), anon = new Client();
const email = `voice-${rnd()}@example.com`;
await owner.json('/api/signup', { method: 'POST', body: { email, password: 'correcthorse' } });
await new Promise((r) => setTimeout(r, 300));
const mail = (await (await fetch(`${FAKE}/__emails?to=${encodeURIComponent(email)}`)).json()).find((m) => /Confirm/.test(m.subject));
await owner.json('/api/verify', { method: 'POST', body: { token: mail.text.match(/token=([a-f0-9]{64})/)[1] } });
const { body: { note } } = await owner.json('/api/notes', { method: 'POST', body: { title: 'Voice' } });
const N = `/api/notes/${note.id}`;

const ids = {};
for (const [name, data, type] of [['webm', WEBM, 'audio/webm;codecs=opus'], ['ogg', OGG, 'audio/ogg'], ['mp3', MP3, 'audio/mpeg'], ['wav', WAV, 'audio/wav'], ['m4a', M4A, 'audio/mp4']]) {
  const res = await owner.upload(data, type);
  const j = await res.json().catch(() => ({}));
  ok(res.status === 201 && j.id, `${name} recording uploads`, JSON.stringify(j));
  ids[name] = j.id;
}
ok((await owner.upload(bytes(1, 2, 3, 4), 'audio/webm')).status === 415, 'unrecognised bytes are refused whatever the label says');

const voice = (id, file, extra = {}) => ({ id, kind: 'voice', t: 5, file, x: 10, y: 20, w: 260, h: 52, dur: 12.5, ...extra });
let r = await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: voice('v1', ids.webm) }] } });
ok(r.status === 200, 'a voice item saves', JSON.stringify(r.body));
r = await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: voice('v2', 'not-a-file-id') }] } });
ok(r.status === 400, 'a voice item needs a real file id');
r = await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: voice('v3', ids.webm, { w: 0 }) }] } });
ok(r.status === 400, 'a voice item needs a size');
r = await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: voice('v4', ids.webm, { text: 'x'.repeat(40001) }) }] } });
ok(r.status === 400, 'a transcript over 40,000 characters is refused');
r = await owner.json(N + '/ops', { method: 'POST', body: { ops: [{ put: voice('v1', ids.webm, { text: 'Remember to call the plumber.' }) }] } });
ok(r.status === 200, 'a transcript can be added to an existing recording');

r = await owner.json(N);
const v1 = (r.body.items || []).find((i) => i.id === 'v1');
ok(v1 && v1.kind === 'voice' && v1.text === 'Remember to call the plumber.' && v1.dur === 12.5, 'the recording and its transcript come back', JSON.stringify(v1));

let f = await fetch(`${B}/api/files/${ids.webm}`, { headers: { cookie: `sid=${owner.jar.get('sid')}`, range: 'bytes=0-9' } });
ok(f.status === 206 && f.headers.get('content-type') === 'video/webm' && (await f.arrayBuffer()).byteLength === 10, 'the recording plays with byte ranges');
f = await fetch(`${B}/api/files/${ids.webm}`, { headers: { cookie: `sid=${anon.jar.get('sid') || ''}` } });
ok(f.status !== 200, "someone else can't fetch the recording");

const link = (await owner.json(N + '/shares', { method: 'POST', body: { mode: 'write', area: '*' } })).body.share;
const E = `/api/shared/${link.token}`;
r = await anon.json(E + '/ops', { method: 'POST', body: { ops: [{ put: voice('v9', ids.webm) }] } });
ok(!(r.body.items || r.body.ok) || (await anon.json(E)).body.items.every((i) => i.id !== 'v9'), "an edit link can't add a recording");
r = await anon.json(E + '/ops', { method: 'POST', body: { ops: [{ put: voice('v1', ids.webm, { x: 99 }) }] } });
ok((await anon.json(E)).body.items.find((i) => i.id === 'v1')?.x === 99, 'an edit link can move an existing recording');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
