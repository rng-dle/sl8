// ThinkSL8 API: email/password accounts, per-user canvases (stored as "notes"), each a set of items, plus AI (src/ai.js).
import { DurableObject } from 'cloudflare:workers';
import { aiRoutes } from './ai.js';
import { EMBEDS } from '../public/embeds.js';
import { canSendMail, sendMail, resetEmail, verifyEmail } from './mail.js';

const OLD_HOSTS = new Set(['sl8.nastaliq.co']); // still served; reset links from it point at thinksl8.com
const SESSION_DAYS = 30;
// [x, y, width, font size, colour, text] for the optional sample canvas created during setup
const SAMPLE = [
  [0, 0, 560, 32, 'ink', 'Welcome to your canvas.'],
  [0, 80, 340, 17, 'ink', 'It keeps going in every direction. Drag with two fingers, scroll, or hold Space and drag to move around. Pinch or Ctrl + scroll to zoom.'],
  [0, 210, 340, 17, 'blue', "Double-tap (or double-click) anywhere to write a thought. It doesn't need a category, a folder or a title."],
  [0, 340, 340, 17, 'red', 'Use Ask AI to connect your AI. Then ask things like "what did I decide about pricing?" and it answers from what you wrote, with links back to the notes it used.'],
  [420, 80, 300, 17, 'ink', 'Pick the pen to handwrite or sketch. With a stylus, pressure shapes the line and your palm is ignored while you write.'],
  [420, 210, 300, 17, 'green', 'Use the select tool to drag a box around things. Move them, delete them, or ask your AI about just those.'],
  [420, 340, 300, 17, 'ink', 'This canvas is a sample. Edit it, keep it, or delete it from Canvases.'],
];
const MAX_OPS = 40; // ponytail: D1 free plan allows 50 queries per request; client sends ops in chunks of 40
const MAX_ITEM_BYTES = 200_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[\w-]{1,64}$/;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const json = (data, status = 200, headers = {}) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (status, error) => json({ error }, status);

async function hashPw(pw, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  // 100k is the Workers maximum for PBKDF2
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256));
}

const cookie = (token, maxAge) => `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function startSession(env, userId, email) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(await sha256(token), userId, now + SESSION_DAYS * 864e5),
  ]);
  return json({ email }, 200, { 'set-cookie': cookie(token, SESSION_DAYS * 86400) });
}

function sessionToken(req) {
  return (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/)?.[1];
}

async function currentUser(req, env) {
  const token = sessionToken(req);
  if (!token) return null;
  return env.DB.prepare(
    'SELECT u.id, u.email, u.onboarded, u.verified FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(await sha256(token), Date.now()).first();
}

const cleanEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const okEmail = (e) => EMAIL.test(e) && e.length <= 254;
const okPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const PW_RULE = 'Password must be at least 8 characters.';

function credentials(body) {
  const email = cleanEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!okEmail(email)) return { error: 'Enter a valid email address.' };
  if (!okPassword(password)) return { error: PW_RULE };
  return { email, password };
}

async function passwordMatches(u, password) {
  if (!u || typeof password !== 'string') return false;
  return crypto.subtle.timingSafeEqual(enc.encode(await hashPw(password, u.pw_salt)), enc.encode(u.pw_hash));
}
async function newPasswordFields(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return [await hashPw(password, salt), salt];
}

// Counts requests per key in a fixed window; true once the limit is passed.
const bucketOf = (windowSec) => { const now = Math.floor(Date.now() / 1000); return now - (now % windowSec); };
async function throttled(env, key, limit, windowSec) {
  const n = await env.DB.prepare(
    'INSERT INTO throttle (key, bucket, n) VALUES (?, ?, 1) ON CONFLICT (key, bucket) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(key, bucketOf(windowSec)).first('n');
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM throttle WHERE bucket < ?').bind(bucketOf(1) - 86400).run();
  return n > limit;
}
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';

// Wrong passwords count per account *and* network, so nobody can lock someone else out by guessing at their email.
const LOGIN_FAILS = 10, LOGIN_WINDOW = 900;
const failKey = (req, email) => `loginfail:${email}:${clientIp(req)}`;
const failures = async (env, key) =>
  (await env.DB.prepare('SELECT n FROM throttle WHERE key = ? AND bucket = ?').bind(key, bucketOf(LOGIN_WINDOW)).first('n')) || 0;

// Cloudflare Turnstile, a bot check, on sign-up, sign-in and reset requests once both keys are set.
const botCheckOn = (env) => !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
async function human(env, req, token) {
  if (!botCheckOn(env)) return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const url = env.TEST_BASE ? `${env.TEST_BASE}/turnstile` : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: clientIp(req) }),
    });
    return (await res.json()).success === true;
  } catch {
    return false; // fail closed: a bot check that can't be checked doesn't pass
  }
}
const NOT_HUMAN = "The check that you're not a bot didn't pass. Try again.";

// Email verification: a link that proves the address is yours. Sharing needs it.
async function sendVerify(env, ctx, url, user) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM verifies WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO verifies VALUES (?, ?, ?)').bind(await sha256(token), user.id, now + 7 * 864e5),
  ]);
  const origin = OLD_HOSTS.has(url.hostname) ? 'https://thinksl8.com' : url.origin;
  ctx.waitUntil(sendMail(env, { to: user.email, ...verifyEmail(`${origin}/verify?token=${token}`) }).catch((e) => console.error('verify email failed', e)));
}

// FTS5 query from what someone typed: every word must appear, matching word starts.
function searchQuery(q) {
  const words = (String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
  return words.map((w) => `"${w}"*`).join(' ');
}

const isId = (v) => typeof v === 'string' && ID.test(v);
function validItem(it) {
  if (!it || typeof it !== 'object' || !isId(it.id) || !Number.isFinite(it.t)) return false;
  if (it.kind === 'stroke' || it.kind === 'text') return true;
  if (it.kind === 'conn') return isId(it.a) && isId(it.b); // arrow from item a to item b
  if (it.kind === 'portal') return isId(it.target); // card that opens another canvas
  if (it.kind === 'embed') return !!EMBEDS[it.service || 'spotify']?.valid.test(it.ref) && [it.x, it.y, it.w, it.h].every(Number.isFinite) && it.w > 0 && it.h > 0; // a player from the embeds list
  if (it.kind === 'image' || it.kind === 'video') { // a photo or video placed on the canvas, from /api/files
    return FILE_ID.test(it.file) && [it.x, it.y, it.w, it.h].every(Number.isFinite) && it.w > 0 && it.h > 0;
  }
  return false;
}

/* Dot-grid containers. Level k cells are CELL * 2^k world units square, aligned to the canvas origin, so each one splits
   into four at level k - 1. Id "k/col/row". An item belongs to the container its first point is in (anchor), and a
   container holds everything in its sub-containers. A share's area is '*' (whole canvas) or a list of containers. */
const CELL = 24, MAX_AREA = 400, AREA = /^(-?\d{1,2})\/(-?\d{1,16})\/(-?\d{1,16})$/;
function cleanArea(v) {
  if (v === '*') return '*';
  if (!Array.isArray(v) || !v.length || v.length > MAX_AREA) return null;
  const out = new Set();
  for (const c of v) {
    const m = typeof c === 'string' && c.match(AREA);
    if (!m || m[1] < -4 || m[1] > 40) return null;
    out.add(m.slice(1).map(Number).join('/'));
  }
  return [...out];
}
const anchor = (it) => (it.kind === 'stroke' ? [it.p?.[0], it.p?.[1]] : [it.x, it.y]);
const inArea = (area, [x, y]) => area === '*' || (Number.isFinite(x) && Number.isFinite(y) &&
  area.some(([k, i, j]) => { const s = CELL * 2 ** k; return Math.floor(x / s) === i && Math.floor(y / s) === j; }));
// whether an item shows in an area: arrows need both ends in it
function shown(area, byId, it) {
  if (area === '*') return true;
  const placed = (x) => x && x.kind !== 'conn' && inArea(area, anchor(x));
  return it.kind === 'conn' ? placed(byId.get(it.a)) && placed(byId.get(it.b)) : placed(it);
}
const TOMB_DAYS = 1; // a device away longer than this reloads the whole canvas instead of catching up

// A canvas's look. Unknown keys and bad values are dropped.
const THEMES = ['light', 'dark', 'paper', 'blueprint', 'chalk'];
const PATTERNS = ['dots', 'grid', 'lines', 'graph', 'iso', 'plain'];
const HEX = /^#[0-9a-f]{6}$/i;
const FILE_ID = /^[0-9a-f-]{36}$/;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
function cleanStyle(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  if (THEMES.includes(v.theme)) out.theme = v.theme;
  if (PATTERNS.includes(v.pattern)) out.pattern = v.pattern;
  if (HEX.test(v.paper)) out.paper = v.paper.toLowerCase();
  if (HEX.test(v.rule)) out.rule = v.rule.toLowerCase();
  if (Number.isFinite(v.size)) out.size = clamp(Math.round(v.size), 8, 96);
  if (typeof v.image === 'string' && FILE_ID.test(v.image)) out.image = v.image;
  if (v.fit === 'tile' || v.fit === 'cover') out.fit = v.fit;
  if (Number.isFinite(v.dim)) out.dim = clamp(Math.round(v.dim * 100) / 100, 0, 0.9);
  return out;
}
const saveStyle = (env, noteId, style) => env.DB.prepare(
  'INSERT INTO canvas_style (note_id, style) VALUES (?, ?) ON CONFLICT (note_id) DO UPDATE SET style = excluded.style'
).bind(noteId, JSON.stringify(style));

/* The marketplace: templates (notes, drawings and arrows plus a look) and themes (a look). Anyone can browse; using one
   copies it into your own canvases. Official items have no user_id; members publish templates from a canvas or JSON. */
const MARKET_KINDS = ['text', 'stroke', 'conn']; // photos, videos and portals point at the author's own files and canvases
const MAX_TEMPLATE_ITEMS = 500, MAX_TEMPLATE_BYTES = 300_000;
const marketStyle = (v) => { const s = cleanStyle(v); delete s.image; delete s.fit; delete s.dim; return s; };
function marketItems(list) {
  if (!Array.isArray(list)) return [];
  const items = list.filter((it) => validItem(it) && MARKET_KINDS.includes(it.kind));
  const ids = new Set(items.map((it) => it.id));
  return items.filter((it) => it.kind !== 'conn' || (ids.has(it.a) && ids.has(it.b)));
}
const ownNote = (env, user, id) => isId(id) ? env.DB.prepare('SELECT id FROM notes WHERE id = ? AND user_id = ?').bind(id, user.id).first() : null;
const styleOf = async (env, noteId) => JSON.parse((await env.DB.prepare('SELECT style FROM canvas_style WHERE note_id = ?').bind(noteId).first('style')) || '{}');

async function marketList(req, env) {
  const user = await currentUser(req, env);
  // ponytail: the newest 200 with their data, for previews; page it when the shelf grows
  const { results } = await env.DB.prepare(
    'SELECT id, kind, user_id, name, description, data, created_at FROM market ORDER BY user_id IS NOT NULL, kind, created_at DESC LIMIT 200'
  ).all();
  const items = results.map((r) => `{"id":${JSON.stringify(r.id)},"kind":${JSON.stringify(r.kind)},"name":${JSON.stringify(r.name)},"description":${JSON.stringify(r.description)},"official":${!r.user_id},"mine":${!!user && r.user_id === user.id},"created_at":${r.created_at},"data":${r.data}}`);
  return json(`{"signedIn":${!!user},"items":[${items.join(',')}]}`);
}

async function marketPublish(env, user, body) {
  if (!user.verified) return json({ error: `Verify your email first: open the link we sent to ${user.email}.`, kind: 'verify' }, 403);
  const name = String(body.name ?? '').trim().slice(0, 60), description = String(body.description ?? '').trim().slice(0, 160);
  if (!name) return fail(400, 'Give the template a name.');
  let items, style;
  if (body.noteId !== undefined) {
    const note = await ownNote(env, user, body.noteId);
    if (!note) return fail(404, 'Canvas not found.');
    items = marketItems((await loadItems(env, note.id)).map((r) => r.it));
    style = marketStyle(await styleOf(env, note.id));
  } else {
    items = marketItems(body.items);
    style = marketStyle(body.style);
  }
  if (!items.length) return fail(400, 'A template needs at least one note, drawing or arrow. Photos, videos and portals are left out.');
  if (items.length > MAX_TEMPLATE_ITEMS) return fail(413, `Templates can hold up to ${MAX_TEMPLATE_ITEMS} notes, drawings and arrows.`);
  const data = JSON.stringify({ style, items });
  if (data.length > MAX_TEMPLATE_BYTES) return fail(413, 'That template is too large. Try a smaller canvas.');
  if (await throttled(env, 'publish:' + user.id, 20, 86400)) return fail(429, 'You can publish 20 templates a day. Try again tomorrow.');
  const id = crypto.randomUUID(), now = Date.now();
  await env.DB.prepare('INSERT INTO market (id, kind, user_id, name, description, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'template', user.id, name, description, data, now, now).run();
  return json({ id }, 201);
}

// Using a template makes a new canvas holding a copy (fresh ids, arrows re-pointed). A theme restyles one of your
// canvases, keeping its background photo, or starts a new canvas with that look.
async function marketUse(env, user, row, body) {
  const { style, items = [] } = JSON.parse(row.data);
  if (row.kind === 'theme' && body.noteId !== undefined) {
    const note = await ownNote(env, user, body.noteId);
    if (!note) return fail(404, 'Canvas not found.');
    const old = await styleOf(env, note.id);
    await saveStyle(env, note.id, cleanStyle({ image: old.image, fit: old.fit, dim: old.dim, ...style })).run();
    return json({ noteId: note.id });
  }
  const id = crypto.randomUUID(), now = Date.now();
  const fresh = new Map(items.map((it) => [it.id, crypto.randomUUID()]));
  const copies = items.map((it, i) => ({ ...it, id: fresh.get(it.id), t: now + i, ...(it.kind === 'conn' && { a: fresh.get(it.a), b: fresh.get(it.b) }) }));
  const stmts = [env.DB.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?)').bind(id, user.id, row.kind === 'theme' ? 'Untitled' : row.name, now, now)];
  if (Object.keys(style).length) stmts.push(saveStyle(env, id, style));
  if (copies.length) stmts.push(env.DB.prepare( // one statement for any size, under D1's per-request query limit
    "INSERT INTO items (note_id, id, t, data, updated_at) SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.t'), value, ? FROM json_each(?)"
  ).bind(id, now, JSON.stringify(copies)));
  await env.DB.batch(stmts);
  return json({ noteId: id }, 201);
}

// Uploaded images: PNG, JPEG, WebP or GIF only (checked by their first bytes, never SVG), 3 MB, 100 per account.
const IMAGE_SIGS = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/gif', [0x47, 0x49, 0x46, 0x38]], ['image/webp', [0x52, 0x49, 0x46, 0x46]]];
const sniffImage = (b) => IMAGE_SIGS.find(([type, sig]) => sig.every((x, i) => b[i] === x) && (type !== 'image/webp' || String.fromCharCode(...b.slice(8, 12)) === 'WEBP'))?.[0];
const sniffVideo = (b) => {
  if (String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return String.fromCharCode(...b.slice(8, 12)) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return null;
};
// ponytail: files live in KV (25 MiB per value, 1 GB on the free plan); move to R2 for longer videos and more room
const MAX_IMAGE = 3 * 1024 * 1024, MAX_VIDEO = 25_000_000, MAX_FILES = 100, MAX_USER_BYTES = 200_000_000;
// Files no canvas uses any more (deleted photos, replaced backgrounds), for clearing room when someone hits a limit.
async function unusedFiles(env, userId, keys) {
  const [items, styles] = await env.DB.batch([
    env.DB.prepare("SELECT i.data FROM items i JOIN notes n ON n.id = i.note_id WHERE n.user_id = ? AND (i.data LIKE '%\"kind\":\"image\"%' OR i.data LIKE '%\"kind\":\"video\"%')").bind(userId),
    env.DB.prepare('SELECT s.style FROM canvas_style s JOIN notes n ON n.id = s.note_id WHERE n.user_id = ?').bind(userId),
  ]);
  const used = new Set([...items.results.map((r) => JSON.parse(r.data).file), ...styles.results.map((r) => JSON.parse(r.style).image)]);
  const settled = Date.now() - 10 * 60_000; // a fresh upload may not be saved onto its canvas yet
  return keys.filter((k) => !used.has(k.name.split(':')[2]) && (k.metadata?.at || 0) < settled);
}
const fileKey = (userId, id) => `img:${userId}:${id}`;
async function deleteFiles(env, userId) {
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: `img:${userId}:`, cursor });
    await Promise.all(page.keys.map((k) => env.FILES.delete(k.name)));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

/* The logo in a user's own colours (Settings > Logo colours): the tab icon, the app icons and the install manifest.
   The icon PNGs in public/ are indexed: palette entries 0..191 run from the logo background to the mark colour and the
   rest are background (corners use tRNS), so recolouring only rewrites the palette. Colours are in the URL, so no login. */
const DEFAULT_LOGO = { bg: '0a2b48', fg: '78d1f9' };
const LOGO_ICONS = new Set(['icon-192', 'icon-512', 'icon-maskable-512', 'apple-touch-icon']);
const LOGO_RAMP = 192;
const SIX_HEX = /^[0-9a-f]{6}$/i;
const logoColors = (url) => {
  const bg = url.searchParams.get('bg') || '', fg = url.searchParams.get('fg') || '';
  return SIX_HEX.test(bg) && SIX_HEX.test(fg) ? { bg: bg.toLowerCase(), fg: fg.toLowerCase() } : DEFAULT_LOGO;
};
let crcTable;
function crc32(bytes) {
  crcTable ||= Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function recolorPng(png, { bg, fg }) {
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [b, f] = [rgb(bg), rgb(fg)];
  const view = new DataView(png.buffer);
  for (let p = 8; p + 12 <= png.length; ) {
    const len = view.getUint32(p), type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    if (type === 'PLTE') {
      for (let i = 0; i < len / 3; i++) {
        const k = i < LOGO_RAMP ? i / (LOGO_RAMP - 1) : 0;
        for (let ch = 0; ch < 3; ch++) png[p + 8 + i * 3 + ch] = Math.round(b[ch] + (f[ch] - b[ch]) * k);
      }
      view.setUint32(p + 8 + len, crc32(png.subarray(p + 4, p + 8 + len)));
      return png;
    }
    p += 12 + len;
  }
  return png;
}
async function logo(req, env, url, path) {
  const c = logoColors(url), q = `?bg=${c.bg}&fg=${c.fg}`;
  const asset = (p) => env.ASSETS.fetch(new URL(p, url.origin));
  const forever = { 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  if (path === '/api/logo/manifest') {
    const m = await (await asset('/manifest.webmanifest')).json();
    m.background_color = m.theme_color = '#' + c.bg;
    m.icons = m.icons.map((i) => ({ ...i, src: i.src.endsWith('.svg') ? '/api/logo/favicon.svg' + q : '/api/logo' + i.src + q }));
    return new Response(JSON.stringify(m), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=86400' } });
  }
  if (path === '/api/logo/favicon.svg') {
    const svg = (await (await asset('/favicon.svg')).text()).replace(/#0a2b48/gi, '#' + c.bg).replace(/#78d1f9/gi, '#' + c.fg);
    return new Response(svg, { headers: { ...forever, 'content-type': 'image/svg+xml', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  const name = path.match(/^\/api\/logo\/([\w-]+)\.png$/)?.[1];
  if (!LOGO_ICONS.has(name)) return fail(404, 'Not found.');
  const png = recolorPng(new Uint8Array(await (await asset(`/${name}.png`)).arrayBuffer()), c);
  return new Response(png, { headers: { ...forever, 'content-type': 'image/png' } });
}

async function serveFile(req, env, userId, id) {
  const { value, metadata } = await env.FILES.getWithMetadata(fileKey(userId, id), 'arrayBuffer');
  if (!value) return fail(404, 'File not found.');
  const headers = {
    'content-type': metadata?.type || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'accept-ranges': 'bytes',
  };
  // byte ranges, so videos can seek
  const range = (req.headers.get('range') || '').match(/^bytes=(\d*)-(\d*)$/), size = value.byteLength;
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(value.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` } });
  }
  return new Response(value, { headers });
}

// ponytail: shared links read the whole canvas to check areas; index anchors in columns if canvases get huge
async function loadItems(env, noteId) {
  const { results } = await env.DB.prepare('SELECT data, updated_at FROM items WHERE note_id = ? ORDER BY t, id').bind(noteId).all();
  return results.map((r) => ({ it: JSON.parse(r.data), data: r.data, at: r.updated_at }));
}

// Apply a batch of puts and deletes. With a share, only changes inside its area count; the rest come back as `rejected`.
async function saveOps(env, noteId, list, share) {
  if (!Array.isArray(list) || list.length > MAX_OPS) return fail(400, `Send between 0 and ${MAX_OPS} changes at a time.`);
  let puts = [], dels = [];
  for (const op of list) {
    if (op && typeof op.del === 'string' && ID.test(op.del)) dels.push(op.del);
    else if (op && validItem(op.put)) {
      const data = JSON.stringify(op.put);
      if (data.length > MAX_ITEM_BYTES) return fail(413, 'One stroke or text box is too large to save.');
      puts.push([op.put, data]);
    } else return fail(400, 'One of the changes was malformed.');
  }
  const rejected = [];
  if (share) {
    const prev = new Map((await loadItems(env, noteId)).map((r) => [r.it.id, r.it]));
    const next = new Map(prev);
    for (const [it] of puts) next.set(it.id, it);
    const ok = (it) => shown(share.area, next, it), was = (it) => !it || shown(share.area, prev, it);
    puts = puts.filter(([it]) => {
      const p = prev.get(it.id);
      // links can't add photos, videos or portals (those point at the owner's files and canvases), only move them
      const fixed = !['image', 'video', 'portal'].includes(it.kind) || (p?.kind === it.kind && p.file === it.file && p.target === it.target);
      if (ok(it) && was(p) && fixed) return true;
      rejected.push(it.id);
      return false;
    });
    dels = dels.filter((id) => {
      if (was(prev.get(id))) return true;
      rejected.push(id);
      return false;
    });
  }
  const now = Date.now();
  const stmts = puts.map(([it, data]) => env.DB.prepare(
    'INSERT INTO items (note_id, id, t, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (note_id, id) DO UPDATE SET t = excluded.t, data = excluded.data, updated_at = excluded.updated_at'
  ).bind(noteId, it.id, it.t, data, now));
  if (dels.length) { // one statement each for any number of deletes, keeping under D1's per-request query limit
    const ids = JSON.stringify(dels);
    stmts.push(env.DB.prepare('DELETE FROM items WHERE note_id = ? AND id IN (SELECT value FROM json_each(?))').bind(noteId, ids));
    stmts.push(env.DB.prepare(
      'INSERT INTO tombstones (note_id, id, at) SELECT ?, value, ? FROM json_each(?) WHERE true ON CONFLICT (note_id, id) DO UPDATE SET at = excluded.at'
    ).bind(noteId, now, ids));
    if (Math.random() < 0.02) stmts.push(env.DB.prepare('DELETE FROM tombstones WHERE at < ?').bind(now - 2 * TOMB_DAYS * 864e5));
  }
  stmts.push(env.DB.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').bind(now, noteId));
  await env.DB.batch(stmts);
  return json(rejected.length ? { ok: true, rejected } : { ok: true });
}

// A canvas's live room: everyone with it open holds a WebSocket here. The owner's copies get each save's changes in the
// push itself, and strokes while they're still being drawn; a share link only hears a ping and fetches the usual way, so
// it never sees past its own squares. Stores nothing, and hibernates between messages.
export class Room extends DurableObject {
  fetch(req) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ owner: req.headers.get('x-owner') === '1' }); // set by join(), never by the browser
    return new Response(null, { status: 101, webSocket: client });
  }
  ping(from, ops) {
    from = String(from).slice(0, 64);
    const full = ops && JSON.stringify({ k: 'ops', from, ops });
    for (const ws of this.ctx.getWebSockets()) try { ws.send(full && ws.deserializeAttachment()?.owner ? full : from); } catch {}
  }
  webSocketMessage(ws, msg) { // a stroke still being drawn, from one of the owner's copies to the others
    if (typeof msg !== 'string' || msg.length > 65536 || !ws.deserializeAttachment()?.owner) return;
    let m; try { m = JSON.parse(msg); } catch { return; }
    const pts = Array.isArray(m?.p) && m.p.length <= 6000 && m.p.length % 3 === 0 && m.p.every(Number.isFinite);
    if ((m.k !== 'draw' && m.k !== 'end') || !ID.test(m.id) || !Number.isInteger(m.from) || m.from < 0 || !pts) return;
    const s = m.s && { c: String(m.s.c).slice(0, 32), w: Number(m.s.w) || 1, pt: m.s.pt ? String(m.s.pt).slice(0, 16) : undefined, hl: !!m.s.hl, pr: !!m.s.pr };
    const out = JSON.stringify({ k: m.k, id: m.id, from: m.from, p: m.p, s });
    for (const peer of this.ctx.getWebSockets()) if (peer !== ws && peer.deserializeAttachment()?.owner) try { peer.send(out); } catch {}
  }
  webSocketClose(ws) { try { ws.close(1000); } catch {} }
}
const room = (env, noteId) => env.ROOM.get(env.ROOM.idFromName(noteId));
function join(env, noteId, req, owner) {
  const r = new Request(req);
  r.headers.set('x-owner', owner ? '1' : '0');
  return room(env, noteId).fetch(r);
}
// after a save, tell the room in the background (a missed push only means waiting for the next poll);
// ops: the owner's own changes, all of which were accepted
async function saved(ctx, env, noteId, body, res, ops) {
  const r = await res;
  if (r.ok) ctx.waitUntil(room(env, noteId).ping(body.tab || '', ops).catch((e) => console.error('room ping failed', e)));
  return r;
}

// What changed since a time another device last asked: changed items and deleted ids.
async function changes(env, noteId, since, area) {
  const now = Date.now();
  if (now - since > TOMB_DAYS * 864e5) return json({ now, reload: true });
  const after = since - 5000; // a write from another Worker instance can land a moment after its timestamp
  const [{ results: rows }, { results: gone }] = await env.DB.batch([
    env.DB.prepare('SELECT data FROM items WHERE note_id = ? AND updated_at > ?').bind(noteId, after),
    env.DB.prepare('SELECT id FROM tombstones t WHERE note_id = ? AND at > ? AND NOT EXISTS (SELECT 1 FROM items i WHERE i.note_id = t.note_id AND i.id = t.id)').bind(noteId, after),
  ]);
  if (area !== '*' && rows.length) { // something changed: check it against the area; items that left it count as deleted
    const all = await loadItems(env, noteId), byId = new Map(all.map((r) => [r.it.id, r.it]));
    const changed = all.filter((r) => r.at > after), vis = changed.filter((r) => shown(area, byId, r.it));
    gone.push(...changed.filter((r) => !vis.includes(r)).map((r) => ({ id: r.it.id })));
    rows.splice(0, rows.length, ...vis);
  }
  return json(`{"now":${now},"gone":${JSON.stringify(gone.map((r) => r.id))},"items":[${rows.map((r) => r.data).join(',')}]}`);
}

// Someone opening a share link. No account needed: the link is the key.
async function shared(req, env, ctx, url, token, ops, fileId, body) {
  const row = await env.DB.prepare('SELECT s.note_id, s.mode, s.area, n.user_id, n.title FROM shares s JOIN notes n ON n.id = s.note_id WHERE s.token = ?').bind(token).first();
  if (!row) return fail(404, 'This link was turned off, or the canvas was deleted.');
  const area = row.area === '*' ? '*' : JSON.parse(row.area).map((c) => c.split('/').map(Number));
  const method = req.method;
  if (ops) {
    if (method !== 'POST') return fail(404, 'Not found.');
    if (row.mode !== 'write') return fail(403, 'This link can view only.');
    return saved(ctx, env, row.note_id, body, saveOps(env, row.note_id, body.ops, { area }));
  }
  if (method !== 'GET') return fail(404, 'Not found.');
  if (!fileId && req.headers.get('upgrade') === 'websocket') return join(env, row.note_id, req, false);
  if (fileId) {
    // only files this link can see: the background, or a photo or video in its area
    const [style, rows] = await Promise.all([
      env.DB.prepare('SELECT style FROM canvas_style WHERE note_id = ?').bind(row.note_id).first('style'), loadItems(env, row.note_id)]);
    const byId = new Map(rows.map((r) => [r.it.id, r.it]));
    const used = JSON.parse(style || '{}').image === fileId || rows.some((r) => r.it.file === fileId && shown(area, byId, r.it));
    return used ? serveFile(req, env, row.user_id, fileId) : fail(404, 'File not found.');
  }
  const since = Number(url.searchParams.get('since'));
  if (since) return changes(env, row.note_id, since, area);
  const [style, rows] = await Promise.all([
    env.DB.prepare('SELECT style FROM canvas_style WHERE note_id = ?').bind(row.note_id).first('style'), loadItems(env, row.note_id)]);
  const byId = new Map(rows.map((r) => [r.it.id, r.it]));
  const note = { title: row.title, style: JSON.parse(style || '{}') };
  const share = { mode: row.mode, area: row.area === '*' ? '*' : JSON.parse(row.area) };
  return json(`{"now":${Date.now()},"note":${JSON.stringify(note)},"share":${JSON.stringify(share)},"items":[${rows.filter((r) => shown(area, byId, r.it)).map((r) => r.data).join(',')}]}`);
}

async function api(req, env, ctx, url) {
  const path = url.pathname;
  const method = req.method;
  if (path.startsWith('/api/logo/') && method === 'GET') return logo(req, env, url, path);

  if (req.headers.get('upgrade')) { // a live connection: only from our own pages
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, 'Request blocked: wrong origin.');
  }
  if (method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, 'Request blocked: wrong origin.');
    if (path !== '/api/files' && !(req.headers.get('content-type') || '').includes('application/json')) return fail(415, 'Send JSON.');
  }
  const body = method === 'GET' || path === '/api/files' ? {} : await req.json().catch(() => ({}));

  if (path === '/api/config' && method === 'GET') return json({ botCheck: botCheckOn(env) ? env.TURNSTILE_SITE_KEY : null });

  if (path === '/api/signup' && method === 'POST') {
    const c = credentials(body);
    if (c.error) return fail(400, c.error);
    if (await throttled(env, 'signup:' + clientIp(req), 10, 3600)) return fail(429, 'Too many new accounts from this network. Try again in an hour.');
    if (!(await human(env, req, body.turnstile))) return fail(400, NOT_HUMAN);
    const id = crypto.randomUUID();
    const [hash, salt] = await newPasswordFields(c.password);
    try {
      await env.DB.prepare('INSERT INTO users (id, email, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, c.email, hash, salt, Date.now()).run();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(409, 'That email already has an account. Log in instead.');
      throw e;
    }
    if (canSendMail(env)) await sendVerify(env, ctx, url, { id, email: c.email });
    return startSession(env, id, c.email);
  }

  if (path === '/api/login' && method === 'POST') {
    const c = credentials(body);
    if (c.error) return fail(400, 'Wrong email or password.');
    if (await throttled(env, 'login:' + clientIp(req), 30, 600)) return fail(429, 'Too many sign-in attempts from this network. Try again in 10 minutes.');
    const fk = failKey(req, c.email);
    if (await failures(env, fk) >= LOGIN_FAILS) return fail(429, 'Too many wrong passwords from this network. Try again in 15 minutes, or reset your password.');
    if (!(await human(env, req, body.turnstile))) return fail(400, NOT_HUMAN);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(c.email).first();
    if (!(await passwordMatches(u, c.password))) {
      await throttled(env, fk, LOGIN_FAILS, LOGIN_WINDOW);
      return fail(401, 'Wrong email or password.');
    }
    return startSession(env, u.id, u.email);
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = sessionToken(req);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }

  if (path === '/api/password/forgot' && method === 'POST') {
    if (!canSendMail(env)) return fail(503, "Password reset by email isn't set up yet.");
    const email = cleanEmail(body.email);
    if (!okEmail(email)) return fail(400, 'Enter a valid email address.');
    if (await throttled(env, 'forgot:' + clientIp(req), 5, 600)) return fail(429, 'Too many reset requests from this network. Try again in 10 minutes.');
    if (!(await human(env, req, body.turnstile))) return fail(400, NOT_HUMAN);
    const sent = json({ ok: true }); // identical reply whether or not the account exists
    if (await throttled(env, 'forgot:' + email, 3, 3600)) return sent;
    const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (!u) return sent;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM resets WHERE expires_at < ?').bind(now),
      env.DB.prepare('INSERT INTO resets VALUES (?, ?, ?)').bind(await sha256(token), u.id, now + 3600e3),
    ]);
    const origin = OLD_HOSTS.has(url.hostname) ? 'https://thinksl8.com' : url.origin;
    ctx.waitUntil(sendMail(env, { to: email, ...resetEmail(`${origin}/reset?token=${token}`) }).catch((e) => console.error('reset email failed', e)));
    return sent;
  }

  if (path === '/api/password/reset' && method === 'POST') {
    const token = typeof body.token === 'string' && /^[a-f0-9]{64}$/.test(body.token) ? body.token : '';
    if (!okPassword(body.password)) return fail(400, PW_RULE);
    const row = token && await env.DB.prepare(
      'SELECT u.id, u.email FROM resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at > ?'
    ).bind(await sha256(token), Date.now()).first();
    if (!row) return fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    const [hash, salt] = await newPasswordFields(body.password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, verified = 1 WHERE id = ?').bind(hash, salt, row.id), // the link proved the mailbox
      env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(row.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id), // sign out everywhere, then sign in here
    ]);
    return startSession(env, row.id, row.email);
  }

  if (path === '/api/verify' && method === 'POST') {
    const token = typeof body.token === 'string' && /^[a-f0-9]{64}$/.test(body.token) ? body.token : '';
    const row = token && await env.DB.prepare('SELECT user_id FROM verifies WHERE token_hash = ? AND expires_at > ?').bind(await sha256(token), Date.now()).first();
    if (!row) return fail(400, 'This link has expired or was already used. Send a new one from Share in any canvas.');
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET verified = 1 WHERE id = ?').bind(row.user_id),
      env.DB.prepare('DELETE FROM verifies WHERE user_id = ?').bind(row.user_id),
    ]);
    return json({ ok: true });
  }

  if (path === '/api/market' && method === 'GET') return marketList(req, env);

  const sh = path.match(/^\/api\/shared\/([a-f0-9]{64})(?:(\/ops)|\/files\/([0-9a-f-]{36}))?$/);
  if (sh) return shared(req, env, ctx, url, sh[1], sh[2], sh[3], body);

  const user = await currentUser(req, env);
  if (!user) return fail(401, 'Log in to continue.');

  if (path === '/api/password/change' && method === 'POST') {
    if (!okPassword(body.password)) return fail(400, PW_RULE);
    if (await throttled(env, 'pwchange:' + user.id, 10, 600)) return fail(429, 'Too many attempts. Try again in 10 minutes.');
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    if (!(await passwordMatches(u, body.current))) return fail(400, 'Your current password is wrong.');
    const [hash, salt] = await newPasswordFields(body.password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').bind(hash, salt, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, await sha256(sessionToken(req))),
    ]);
    return json({ ok: true });
  }

  if (path === '/api/logout-all' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }

  if (path === '/api/account/delete' && method === 'POST') {
    if (await throttled(env, 'delete:' + user.id, 10, 600)) return fail(429, 'Too many attempts. Try again in 10 minutes.');
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    if (!(await passwordMatches(u, body.password))) return fail(400, 'That password is wrong, so nothing was deleted.');
    const mine = 'SELECT id FROM notes WHERE user_id = ?';
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM items WHERE note_id IN (${mine})`).bind(user.id),
      ...['canvas_style', 'shares', 'tombstones'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE note_id IN (${mine})`).bind(user.id)),
      ...['notes', 'ai_connections', 'ai_usage', 'resets', 'verifies', 'sessions'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    ctx.waitUntil(deleteFiles(env, user.id).catch((e) => console.error('file cleanup failed', e)));
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }

  if (path === '/api/files' && method === 'POST') {
    const bytes = new Uint8Array(await req.arrayBuffer());
    const image = sniffImage(bytes), type = image || sniffVideo(bytes);
    if (!type) return fail(415, 'Use a photo (JPEG, PNG, WebP or GIF) or a video (MP4, MOV or WebM).');
    if (image && bytes.length > MAX_IMAGE) return fail(413, 'That image is over 3 MB. Try a smaller one.');
    if (!image && bytes.length > MAX_VIDEO) return fail(413, 'Videos can be up to 25 MB for now, about 20 to 30 seconds from a phone.');
    let { keys } = await env.FILES.list({ prefix: `img:${user.id}:` }); // one page holds 1000, well over the limit
    const full = () => keys.length >= MAX_FILES || keys.reduce((n, k) => n + (k.metadata?.size || 0), 0) + bytes.length > MAX_USER_BYTES;
    if (full()) { // clear out files no canvas uses before saying no
      const unused = await unusedFiles(env, user.id, keys);
      await Promise.all(unused.map((k) => env.FILES.delete(k.name)));
      keys = keys.filter((k) => !unused.includes(k));
      if (full()) return fail(409, `You've used your space for photos and videos (${MAX_FILES} files or ${MAX_USER_BYTES / 1e6} MB). Delete some from your canvases to add more.`);
    }
    const id = crypto.randomUUID();
    await env.FILES.put(fileKey(user.id, id), bytes, { metadata: { type, size: bytes.length, at: Date.now() } });
    return json({ id }, 201);
  }

  const file = path.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (file && method === 'GET') return serveFile(req, env, user.id, file[1]);

  if (path === '/api/export' && method === 'GET') {
    const [{ results: notes }, { results: rows }, acct] = await Promise.all([
      env.DB.prepare('SELECT id, title, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY created_at').bind(user.id).all(),
      env.DB.prepare('SELECT note_id, data FROM items WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?) ORDER BY t').bind(user.id).all(),
      env.DB.prepare('SELECT created_at FROM users WHERE id = ?').bind(user.id).first(),
    ]);
    const { results: styles } = await env.DB.prepare('SELECT note_id, style FROM canvas_style WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?)').bind(user.id).all();
    const styleOf = Object.fromEntries(styles.map((r) => [r.note_id, JSON.parse(r.style)]));
    const byNote = Object.fromEntries(notes.map((n) => [n.id, { ...n, style: styleOf[n.id] || {}, items: [] }]));
    for (const r of rows) byNote[r.note_id]?.items.push(JSON.parse(r.data));
    const day = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify({
      format: 'thinksl8-export-1', exported_at: new Date().toISOString(),
      account: { email: user.email, created_at: acct?.created_at }, canvases: Object.values(byNote),
    }, null, 1), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="thinksl8-${day}.json"` },
    });
  }

  if (path === '/api/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').slice(0, 200);
    const m = searchQuery(q);
    if (!m) return json({ results: [], canvases: [] });
    const [{ results }, { results: canvases }] = await Promise.all([
      env.DB.prepare(
        `SELECT i.id, i.note_id AS noteId, n.title, i.updated_at AS updated, snippet(items_fts, 0, char(1), char(2), '…', 14) AS snippet
         FROM items_fts JOIN items i ON i.rowid = items_fts.rowid JOIN notes n ON n.id = i.note_id
         WHERE items_fts MATCH ? AND n.user_id = ? ORDER BY bm25(items_fts) LIMIT 30`
      ).bind(m, user.id).all(),
      env.DB.prepare("SELECT id, title, updated_at FROM notes WHERE user_id = ? AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 10")
        .bind(user.id, '%' + q.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%').all(),
    ]);
    return json({ results, canvases });
  }

  if (path === '/api/me' && method === 'GET') {
    const last = await env.DB.prepare('SELECT id FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').bind(user.id).first('id');
    return json({ email: user.email, onboarded: !!user.onboarded, verified: !!user.verified, lastNoteId: last || null });
  }
  if (path === '/api/verify/resend' && method === 'POST') {
    if (user.verified) return json({ ok: true });
    if (!canSendMail(env)) return fail(503, "Email isn't set up on this server yet, so verification links can't be sent.");
    if (await throttled(env, 'verify:' + user.id, 3, 3600)) return fail(429, 'Three links were sent in the last hour. Check spam, or try again later.');
    await sendVerify(env, ctx, url, user);
    return json({ ok: true });
  }
  if (path === '/api/me/onboarded' && method === 'POST') {
    await env.DB.prepare('UPDATE users SET onboarded = 1 WHERE id = ?').bind(user.id).run();
    return json({ ok: true });
  }

  if (path === '/api/market' && method === 'POST') return marketPublish(env, user, body);
  const mk = path.match(/^\/api\/market\/([\w-]{1,64})(\/use)?$/);
  if (mk) {
    const row = await env.DB.prepare('SELECT * FROM market WHERE id = ?').bind(mk[1]).first();
    if (!row) return fail(404, 'That template or theme was taken down.');
    if (mk[2] && method === 'POST') return marketUse(env, user, row, body);
    if (!mk[2] && method === 'DELETE') {
      if (row.user_id !== user.id) return fail(403, 'You can only take down what you published.');
      await env.DB.prepare('DELETE FROM market WHERE id = ?').bind(row.id).run();
      return json({ ok: true });
    }
    return fail(404, 'Not found.');
  }

  if (path.startsWith('/api/ai')) return aiRoutes(req, env, ctx, url, user, body);

  if (path === '/api/notes') {
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, title, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC'
      ).bind(user.id).all();
      return json({ notes: results });
    }
    if (method === 'POST') {
      const now = Date.now();
      const sample = body.sample === true;
      const note = { id: crypto.randomUUID(), title: sample ? 'Start here' : String(body.title || 'Untitled').slice(0, 200), updated_at: now };
      const stmts = [env.DB.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?)').bind(note.id, user.id, note.title, now, now)];
      const style = cleanStyle(body.style);
      if (Object.keys(style).length) stmts.push(saveStyle(env, note.id, style));
      if (sample) {
        SAMPLE.forEach(([x, y, w, s, c, text], i) => {
          const it = { id: crypto.randomUUID(), kind: 'text', t: now + i, x, y, w, s, c, text };
          stmts.push(env.DB.prepare('INSERT INTO items (note_id, id, t, data, updated_at) VALUES (?, ?, ?, ?, ?)').bind(note.id, it.id, it.t, JSON.stringify(it), now));
        });
      }
      await env.DB.batch(stmts);
      return json({ note }, 201);
    }
  }

  const m = path.match(/^\/api\/notes\/([\w-]{1,64})(?:(\/ops)|(\/shares)(?:\/([a-f0-9]{64}))?)?$/);
  if (m) {
    const [, noteId, ops, shares, token] = m;
    const note = await env.DB.prepare('SELECT id, title, updated_at FROM notes WHERE id = ? AND user_id = ?')
      .bind(noteId, user.id).first();
    if (!note) return fail(404, 'Note not found.');

    if (ops && method === 'POST') return saved(ctx, env, noteId, body, saveOps(env, noteId, body.ops), body.ops);
    if (!ops && !shares && req.headers.get('upgrade') === 'websocket') return join(env, noteId, req, true);

    if (shares) {
      if (token && method === 'DELETE') {
        await env.DB.prepare('DELETE FROM shares WHERE token = ? AND note_id = ?').bind(token, noteId).run();
        return json({ ok: true });
      }
      if (!token && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT token, mode, area, created_at FROM shares WHERE note_id = ? ORDER BY created_at').bind(noteId).all();
        return json({ shares: results.map((s) => ({ ...s, area: s.area === '*' ? '*' : JSON.parse(s.area) })) });
      }
      if (!token && method === 'POST') {
        if (!user.verified) return json({ error: `Verify your email first: open the link we sent to ${user.email}.`, kind: 'verify' }, 403);
        const area = cleanArea(body.area);
        if (!area) return fail(400, `Choose the whole canvas or between 1 and ${MAX_AREA} squares.`);
        if (body.mode !== 'read' && body.mode !== 'write') return fail(400, 'Choose view or edit.');
        const n = await env.DB.prepare('SELECT count(*) AS n FROM shares WHERE note_id = ?').bind(noteId).first('n');
        if (n >= 50) return fail(409, 'This canvas has 50 links. Turn some off to make more.');
        const s = { token: hex(crypto.getRandomValues(new Uint8Array(32))), mode: body.mode, area, created_at: Date.now() };
        await env.DB.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?)').bind(s.token, noteId, s.mode, area === '*' ? '*' : JSON.stringify(area), s.created_at).run();
        return json({ share: s }, 201);
      }
      return fail(404, 'Not found.');
    }

    if (!ops && method === 'GET') {
      const since = Number(url.searchParams.get('since'));
      if (since) return changes(env, noteId, since, '*');
      const [{ results }, style] = await Promise.all([
        env.DB.prepare('SELECT data FROM items WHERE note_id = ? ORDER BY t, id').bind(noteId).all(),
        env.DB.prepare('SELECT style FROM canvas_style WHERE note_id = ?').bind(noteId).first('style'),
      ]);
      // items are stored as JSON already; splice them in without re-parsing
      return json(`{"now":${Date.now()},"note":${JSON.stringify({ ...note, style: JSON.parse(style || '{}') })},"items":[${results.map((r) => r.data).join(',')}]}`);
    }

    if (!ops && method === 'PATCH') {
      const out = {};
      const stmts = [];
      if (body.title !== undefined) {
        out.title = String(body.title ?? '').trim().slice(0, 200) || 'Untitled';
        stmts.push(env.DB.prepare('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?').bind(out.title, Date.now(), noteId));
      }
      if (body.style !== undefined) {
        out.style = cleanStyle(body.style);
        stmts.push(saveStyle(env, noteId, out.style));
      }
      if (stmts.length) await env.DB.batch(stmts);
      return json(out);
    }

    if (!ops && method === 'DELETE') {
      await env.DB.batch([
        ...['canvas_style', 'shares', 'tombstones'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE note_id = ?`).bind(noteId)),
        env.DB.prepare('DELETE FROM items WHERE note_id = ?').bind(noteId),
        env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(noteId),
      ]);
      return json({ ok: true });
    }
  }

  return fail(404, 'Not found.');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, ctx, url);
    } catch (e) {
      console.error(e);
      return fail(500, 'The server hit an error. Try again in a moment.');
    }
  },
};
