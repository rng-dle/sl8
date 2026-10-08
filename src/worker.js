// sl8 API: email/password accounts, per-user notes, each note a set of canvas items.
const SESSION_DAYS = 30;
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
    'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(await sha256(token), Date.now()).first();
}

function credentials(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!EMAIL.test(email) || email.length > 254) return { error: 'Enter a valid email address.' };
  if (password.length < 8 || password.length > 200) return { error: 'Password must be at least 8 characters.' };
  return { email, password };
}

function validItem(it) {
  return it && typeof it === 'object' && typeof it.id === 'string' && ID.test(it.id) &&
    (it.kind === 'stroke' || it.kind === 'text') && Number.isFinite(it.t);
}

async function api(req, env, url) {
  const path = url.pathname;
  const method = req.method;

  if (method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, 'Request blocked: wrong origin.');
    if (!(req.headers.get('content-type') || '').includes('application/json')) return fail(415, 'Send JSON.');
  }
  const body = method === 'GET' ? {} : await req.json().catch(() => ({}));

  if (path === '/api/signup' && method === 'POST') {
    const c = credentials(body);
    if (c.error) return fail(400, c.error);
    const id = crypto.randomUUID();
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    try {
      await env.DB.prepare('INSERT INTO users (id, email, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, c.email, await hashPw(c.password, salt), salt, Date.now()).run();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(409, 'That email already has an account. Log in instead.');
      throw e;
    }
    return startSession(env, id, c.email);
  }

  if (path === '/api/login' && method === 'POST') {
    const c = credentials(body);
    if (c.error) return fail(400, 'Wrong email or password.');
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(c.email).first();
    const now = Date.now();
    if (u && u.locked_until > now) return fail(429, 'Too many wrong attempts. Try again in 15 minutes.');
    const ok = u && crypto.subtle.timingSafeEqual(enc.encode(await hashPw(c.password, u.pw_salt)), enc.encode(u.pw_hash));
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

  const user = await currentUser(req, env);
  if (!user) return fail(401, 'Log in to continue.');

  if (path === '/api/me') return json({ email: user.email });

  if (path === '/api/notes') {
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, title, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC'
      ).bind(user.id).all();
      return json({ notes: results });
    }
    if (method === 'POST') {
      const now = Date.now();
      const note = { id: crypto.randomUUID(), title: String(body.title || 'Untitled').slice(0, 200), updated_at: now };
      await env.DB.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?)').bind(note.id, user.id, note.title, now, now).run();
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
            'INSERT INTO items (note_id, id, t, data) VALUES (?, ?, ?, ?) ON CONFLICT (note_id, id) DO UPDATE SET t = excluded.t, data = excluded.data'
          ).bind(noteId, op.put.id, op.put.t, data));
        } else {
          return fail(400, 'One of the changes was malformed.');
        }
      }
      stmts.push(env.DB.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').bind(Date.now(), noteId));
      await env.DB.batch(stmts);
      return json({ ok: true });
    }

    if (!ops && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT data FROM items WHERE note_id = ? ORDER BY t, id').bind(noteId).all();
      // items are stored as JSON already; splice them in without re-parsing
      return json(`{"note":${JSON.stringify(note)},"items":[${results.map((r) => r.data).join(',')}]}`);
    }

    if (!ops && method === 'PATCH') {
      const title = String(body.title ?? '').trim().slice(0, 200) || 'Untitled';
      await env.DB.prepare('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?').bind(title, Date.now(), noteId).run();
      return json({ title });
    }

    if (!ops && method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM items WHERE note_id = ?').bind(noteId),
        env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(noteId),
      ]);
      return json({ ok: true });
    }
  }

  return fail(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      console.error(e);
      return fail(500, 'The server hit an error. Try again in a moment.');
    }
  },
};
