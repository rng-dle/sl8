// ThinkSL8 API: email/password accounts, per-user canvases (stored as "notes"), each a set of items, plus AI (src/ai.js).
import { aiRoutes } from './ai.js';
import { canSendMail, sendMail, resetEmail } from './mail.js';

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
    'SELECT u.id, u.email, u.onboarded FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
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
async function throttled(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = now - (now % windowSec);
  const n = await env.DB.prepare(
    'INSERT INTO throttle (key, bucket, n) VALUES (?, ?, 1) ON CONFLICT (key, bucket) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(key, bucket).first('n');
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM throttle WHERE bucket < ?').bind(now - 86400).run();
  return n > limit;
}
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';

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
  return false;
}

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

// Uploaded images: PNG, JPEG, WebP or GIF only (checked by their first bytes, never SVG), 3 MB, 100 per account.
const IMAGE_SIGS = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/gif', [0x47, 0x49, 0x46, 0x38]], ['image/webp', [0x52, 0x49, 0x46, 0x46]]];
const sniffImage = (b) => IMAGE_SIGS.find(([type, sig]) => sig.every((x, i) => b[i] === x) && (type !== 'image/webp' || String.fromCharCode(...b.slice(8, 12)) === 'WEBP'))?.[0];
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

async function api(req, env, ctx, url) {
  const path = url.pathname;
  const method = req.method;
  if (path.startsWith('/api/logo/') && method === 'GET') return logo(req, env, url, path);

  if (method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, 'Request blocked: wrong origin.');
    if (path !== '/api/files' && !(req.headers.get('content-type') || '').includes('application/json')) return fail(415, 'Send JSON.');
  }
  const body = method === 'GET' || path === '/api/files' ? {} : await req.json().catch(() => ({}));

  if (path === '/api/signup' && method === 'POST') {
    const c = credentials(body);
    if (c.error) return fail(400, c.error);
    if (await throttled(env, 'signup:' + clientIp(req), 10, 3600)) return fail(429, 'Too many new accounts from this network. Try again in an hour.');
    const id = crypto.randomUUID();
    const [hash, salt] = await newPasswordFields(c.password);
    try {
      await env.DB.prepare('INSERT INTO users (id, email, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, c.email, hash, salt, Date.now()).run();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(409, 'That email already has an account. Log in instead.');
      throw e;
    }
    return startSession(env, id, c.email);
  }

  if (path === '/api/login' && method === 'POST') {
    const c = credentials(body);
    if (c.error) return fail(400, 'Wrong email or password.');
    if (await throttled(env, 'login:' + clientIp(req), 30, 600)) return fail(429, 'Too many sign-in attempts from this network. Try again in 10 minutes.');
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(c.email).first();
    const now = Date.now();
    if (u && u.locked_until > now) return fail(429, 'Too many wrong attempts. Try again in 15 minutes, or reset your password.');
    const ok = await passwordMatches(u, c.password);
    if (!ok) {
      if (u) {
        const fails = u.fails + 1;
        await env.DB.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE id = ?')
          .bind(fails >= 10 ? 0 : fails, fails >= 10 ? now + 15 * 60e3 : 0, u.id).run();
      }
      return fail(401, 'Wrong email or password.');
    }
    if (u.fails) await env.DB.prepare('UPDATE users SET fails = 0 WHERE id = ?').bind(u.id).run();
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
      env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, fails = 0, locked_until = 0 WHERE id = ?').bind(hash, salt, row.id),
      env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(row.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id), // sign out everywhere, then sign in here
    ]);
    return startSession(env, row.id, row.email);
  }

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
      env.DB.prepare(`DELETE FROM canvas_style WHERE note_id IN (${mine})`).bind(user.id),
      ...['notes', 'ai_connections', 'ai_usage', 'resets', 'sessions'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    ctx.waitUntil(deleteFiles(env, user.id).catch((e) => console.error('file cleanup failed', e)));
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }

  if (path === '/api/files' && method === 'POST') {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > 3 * 1024 * 1024) return fail(413, 'That image is over 3 MB. Try a smaller one.');
    const type = sniffImage(bytes);
    if (!type) return fail(415, 'Use a PNG, JPEG, WebP or GIF image.');
    const existing = await env.FILES.list({ prefix: `img:${user.id}:`, limit: 101 });
    if (existing.keys.length >= 100) return fail(409, 'You have 100 uploaded images, the current limit.');
    const id = crypto.randomUUID();
    await env.FILES.put(fileKey(user.id, id), bytes, { metadata: { type } });
    return json({ id }, 201);
  }

  const file = path.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (file && method === 'GET') {
    const { value, metadata } = await env.FILES.getWithMetadata(fileKey(user.id, file[1]), 'arrayBuffer');
    if (!value) return fail(404, 'Image not found.');
    return new Response(value, { headers: {
      'content-type': metadata?.type || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'",
    } });
  }

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
    return json({ email: user.email, onboarded: !!user.onboarded, lastNoteId: last || null });
  }
  if (path === '/api/me/onboarded' && method === 'POST') {
    await env.DB.prepare('UPDATE users SET onboarded = 1 WHERE id = ?').bind(user.id).run();
    return json({ ok: true });
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

  const m = path.match(/^\/api\/notes\/([\w-]{1,64})(\/ops)?$/);
  if (m) {
    const [, noteId, ops] = m;
    const note = await env.DB.prepare('SELECT id, title, updated_at FROM notes WHERE id = ? AND user_id = ?')
      .bind(noteId, user.id).first();
    if (!note) return fail(404, 'Note not found.');

    if (ops && method === 'POST') {
      const list = Array.isArray(body.ops) ? body.ops : null;
      if (!list || list.length > MAX_OPS) return fail(400, `Send between 0 and ${MAX_OPS} changes at a time.`);
      const stmts = [];
      for (const op of list) {
        if (op && typeof op.del === 'string' && ID.test(op.del)) {
          stmts.push(env.DB.prepare('DELETE FROM items WHERE note_id = ? AND id = ?').bind(noteId, op.del));
        } else if (op && validItem(op.put)) {
          const data = JSON.stringify(op.put);
          if (data.length > MAX_ITEM_BYTES) return fail(413, 'One stroke or text box is too large to save.');
          stmts.push(env.DB.prepare(
            'INSERT INTO items (note_id, id, t, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (note_id, id) DO UPDATE SET t = excluded.t, data = excluded.data, updated_at = excluded.updated_at'
          ).bind(noteId, op.put.id, op.put.t, data, Date.now()));
        } else {
          return fail(400, 'One of the changes was malformed.');
        }
      }
      stmts.push(env.DB.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').bind(Date.now(), noteId));
      await env.DB.batch(stmts);
      return json({ ok: true });
    }

    if (!ops && method === 'GET') {
      const [{ results }, style] = await Promise.all([
        env.DB.prepare('SELECT data FROM items WHERE note_id = ? ORDER BY t, id').bind(noteId).all(),
        env.DB.prepare('SELECT style FROM canvas_style WHERE note_id = ?').bind(noteId).first('style'),
      ]);
      // items are stored as JSON already; splice them in without re-parsing
      return json(`{"note":${JSON.stringify({ ...note, style: JSON.parse(style || '{}') })},"items":[${results.map((r) => r.data).join(',')}]}`);
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
        env.DB.prepare('DELETE FROM canvas_style WHERE note_id = ?').bind(noteId),
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
