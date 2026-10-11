// AI for ThinkSL8: provider connections, retrieval from saved canvases, and streamed answers.
// Provider keys are encrypted at rest (AES-GCM, KEY_ENC_SECRET) and never sent to the browser.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PROVIDERS = {
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', style: 'openai', signIn: true, keysUrl: 'https://openrouter.ai/settings/keys' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', style: 'openai', keysUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic', base: 'https://api.anthropic.com/v1', style: 'anthropic', keysUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', style: 'openai', keysUrl: 'https://aistudio.google.com/apikey' },
};
const SCOPES = ['selection', 'canvas', 'all'];
const SCOPE_LABEL = { selection: 'selected items', canvas: 'this canvas', all: 'all your canvases' };
const ACTIONS = ['ask', 'summarize', 'plan', 'develop'];
const DAILY_CAP = 200; // ponytail: flat per-user cap; make it per-plan if ThinkSL8 ever pays for inference
const CONTEXT_CHARS = 16000;
const SNIPPET_CHARS = 1500;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });

/* ---------- secrets ---------- */
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sealKey(env) {
  const s = env.KEY_ENC_SECRET;
  if (!s || s.length < 32) return null; // refuse to store provider keys without a real secret
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(s)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(key, userId, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(userId) }, key, enc.encode(text));
  return b64(iv) + '.' + b64(ct);
}
async function unseal(key, userId, sealed) {
  const [iv, ct] = sealed.split('.').map(unb64);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(userId) }, key, ct));
}

/* ---------- providers ---------- */
class ProviderError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
// AI_TEST_BASE points every provider at a local stand-in during tests; production never sets it
const baseOf = (env, p) => (env.AI_TEST_BASE ? `${env.AI_TEST_BASE}/${p}` : PROVIDERS[p].base);

function headersFor(p, key) {
  if (PROVIDERS[p].style === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  const h = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  if (p === 'openrouter') Object.assign(h, { 'HTTP-Referer': 'https://thinksl8.com', 'X-Title': 'ThinkSL8' });
  return h;
}

async function providerError(p, res) {
  const label = PROVIDERS[p].label;
  let detail = '';
  try {
    const j = JSON.parse(await res.text());
    detail = String(j.error?.message || j.message || '').slice(0, 200);
  } catch {}
  const s = res.status;
  if (s === 401 || s === 403) return new ProviderError('auth', `${label} rejected the connection. It may have been revoked or expired. Reconnect to keep using AI.`);
  if (s === 402) return new ProviderError('credits', `Your ${label} account is out of credits. Add credits on ${label}, or choose a free model in Settings.`);
  if (s === 429) return new ProviderError('rate', `${label} is limiting requests right now${detail ? ` (${detail})` : ''}. Try again shortly.`);
  if (s === 404 || /model/i.test(detail)) return new ProviderError('model', `${label} couldn't use the selected model${detail ? `: ${detail}` : ''}. Choose another model in Settings.`);
  return new ProviderError('provider', `${label} returned an error${detail ? `: ${detail}` : ''}. Try again.`);
}

async function call(env, p, path, key, init = {}) {
  let res;
  try {
    res = await fetch(baseOf(env, p) + path, { ...init, headers: headersFor(p, key) });
  } catch {
    throw new ProviderError('network', `Couldn't reach ${PROVIDERS[p].label}. Try again in a moment.`);
  }
  if (!res.ok) throw await providerError(p, res);
  return res;
}

const NOT_CHAT = /embed|tts|audio|realtime|transcribe|image|dall-e|whisper|moderation|search|live|aqa|imagen|veo|computer-use/i;
async function listModels(env, p, key) {
  const { data = [] } = await (await call(env, p, '/models', key)).json();
  let models = data
    .filter((m) => p !== 'openrouter' || (m.architecture?.output_modalities ?? ['text']).includes('text'))
    .map((m) => {
      const id = String(m.id).replace(/^models\//, '');
      return { id, name: m.name || m.display_name || id, created: m.created || Date.parse(m.created_at || '') / 1000 || 0, free: p === 'openrouter' && id.endsWith(':free') };
    });
  if (p !== 'openrouter') models = models.filter((m) => !NOT_CHAT.test(m.id));
  if (p === 'openai') models = models.filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id));
  if (p === 'gemini') models = models.filter((m) => m.id.includes('gemini'));
  return models.sort((a, b) => b.created - a.created);
}

function defaultModel(p, models, freeOnly) {
  if (p === 'openrouter') {
    if (!freeOnly) return 'openrouter/auto';
    const free = models.filter((m) => m.free);
    return (free.find((m) => /llama|gemma|qwen|deepseek|mistral/i.test(m.id)) || free[0])?.id || 'openrouter/auto';
  }
  const prefer = { openai: /^gpt-/, anthropic: /sonnet/i, gemini: /flash(?!.*lite)/i }[p];
  return (models.find((m) => prefer.test(m.id)) || models[0])?.id;
}

// Proves the key can actually reach models before calling the connection "connected".
async function checkConnection(env, p, key) {
  const models = await listModels(env, p, key);
  let freeOnly = false;
  if (p === 'openrouter') {
    const info = await (await call(env, p, '/key', key)).json();
    freeOnly = info.data?.is_free_tier !== false;
  }
  const model = defaultModel(p, models, freeOnly);
  if (!model) throw new ProviderError('model', `${PROVIDERS[p].label} didn't list any chat models for this key.`);
  return { models, model };
}

async function* streamChat(env, p, key, model, system, messages) {
  const anthropic = PROVIDERS[p].style === 'anthropic';
  const body = anthropic
    ? { model, system, messages, max_tokens: 4096, stream: true }
    : { model, messages: [{ role: 'system', content: system }, ...messages], stream: true, ...(p === 'openai' ? { max_completion_tokens: 8000 } : { max_tokens: 4096 }) };
  const res = await call(env, p, anthropic ? '/messages' : '/chat/completions', key, { method: 'POST', body: JSON.stringify(body) });
  const reader = res.body.getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // SSE comments and event names
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new ProviderError('provider', `${PROVIDERS[p].label} stopped with an error: ${String(j.error.message || 'unknown').slice(0, 200)}`);
      const text = anthropic ? (j.type === 'content_block_delta' ? j.delta?.text : '') : j.choices?.[0]?.delta?.content;
      if (text) yield text;
    }
  }
}

/* ---------- retrieval ---------- */
const STOP = new Set(('a an and are as at be by for from has have how i in is it its me my of on or our so that the their them then there these ' +
  'they this to was we were what when where which who why will with you your about did do does into than too can could would should just also ' +
  'any some all write wrote written said say note notes canvas last week month day today yesterday').split(' '));
function ftsQuery(q) {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].filter((w) => !STOP.has(w)).slice(0, 12);
  return words.map((w) => `"${w}"`).join(' OR ');
}
const COLS = `i.id, i.note_id AS noteId, i.updated_at AS updated, json_extract(i.data, '$.text') AS text, n.title`;
const IS_TEXT = `json_extract(i.data, '$.kind') = 'text'`;

function fit(rows) {
  const out = [], seen = new Set();
  let used = 0;
  for (const r of rows) {
    const text = String(r.text || '').trim();
    if (!text || seen.has(r.id)) continue;
    seen.add(r.id);
    const clipped = text.length > SNIPPET_CHARS ? text.slice(0, SNIPPET_CHARS) + '…' : text;
    if (used + clipped.length > CONTEXT_CHARS) break;
    used += clipped.length;
    out.push({ ...r, text: clipped });
  }
  return out;
}

async function retrieve(env, userId, { scope, noteId, itemIds, question }) {
  if (scope === 'selection') {
    if (!itemIds.length) return [];
    const { results } = await env.DB.prepare(
      `SELECT ${COLS} FROM items i JOIN notes n ON n.id = i.note_id
       WHERE n.user_id = ? AND i.note_id = ? AND ${IS_TEXT} AND i.id IN (SELECT value FROM json_each(?)) ORDER BY i.updated_at DESC`
    ).bind(userId, noteId, JSON.stringify(itemIds)).all();
    return fit(results);
  }
  const where = scope === 'canvas' ? 'AND i.note_id = ?' : '';
  const args = scope === 'canvas' ? [userId, noteId] : [userId];
  const { results: recent } = await env.DB.prepare(
    `SELECT ${COLS} FROM items i JOIN notes n ON n.id = i.note_id WHERE n.user_id = ? ${where} AND ${IS_TEXT} ORDER BY i.updated_at DESC LIMIT 200`
  ).bind(...args).all();
  const size = recent.reduce((s, r) => s + String(r.text || '').length, 0);
  if (recent.length < 200 && size <= CONTEXT_CHARS) return fit(recent); // the whole scope fits: send all of it
  // ponytail: keyword search (FTS5 + bm25), topped up with recent edits; add embeddings when paraphrases get missed
  const m = ftsQuery(question);
  const hits = m ? (await env.DB.prepare(
    `SELECT ${COLS} FROM items_fts JOIN items i ON i.rowid = items_fts.rowid JOIN notes n ON n.id = i.note_id
     WHERE items_fts MATCH ? AND n.user_id = ? ${where} ORDER BY bm25(items_fts) LIMIT 20`
  ).bind(m, ...args).all()).results : [];
  return fit([...hits, ...recent]);
}

/* ---------- prompting ---------- */
function dateFmt(tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  }
}
const INSTRUCTIONS = {
  ask: 'Answer the request.',
  summarize: 'Summarize these notes: the main ideas, how they connect, and any open questions.',
  plan: 'Turn these notes into a concrete plan: ordered steps, then decisions still needed and open questions.',
  develop: 'Develop the idea in these notes: strengthen it, add angles and next steps the user may not have considered, and point out weak spots.',
};

function buildPrompt(sources, { scope, action, question, tz }) {
  const fmt = dateFmt(tz);
  const system = [
    `You are the AI inside ThinkSL8, the user's personal thinking canvas. Today is ${fmt.format(new Date())}.`,
    `Below are the user's own notes from ${SCOPE_LABEL[scope]}, numbered, each with its canvas and the date it was last edited.`,
    'Ground your answer in these notes and cite them inline like [2]. If the notes don\'t contain what is asked, say so plainly and don\'t invent their content. You may add general knowledge when it helps, but label it as such.',
    'Only typed text is shown to you; handwriting and drawings on the canvas are not.',
    'Write plainly and concisely. Use short lists when they help. No preamble.',
  ].join('\n');
  const notes = sources.length
    ? sources.map((s, i) => `[${i + 1}] Canvas "${s.title}", edited ${fmt.format(new Date(s.updated || 0))}:\n${s.text}`).join('\n\n')
    : '(No typed notes in this scope.)';
  const request = action === 'ask' ? question : `${INSTRUCTIONS[action]}${question ? `\nExtra direction from the user: ${question}` : ''}`;
  return { system, user: `Notes:\n\n${notes}\n\nRequest: ${request}` };
}

/* ---------- connection storage ---------- */
const getConn = (env, userId) => env.DB.prepare('SELECT * FROM ai_connections WHERE user_id = ?').bind(userId).first();
const markReconnect = (env, userId) => env.DB.prepare("UPDATE ai_connections SET status = 'reconnect' WHERE user_id = ?").bind(userId).run();

function summary(c) {
  if (!c) return null;
  const p = PROVIDERS[c.provider];
  return { provider: c.provider, label: p.label, method: c.method, hint: c.hint, model: c.model, scope: c.scope, status: c.status, keysUrl: p.keysUrl };
}

async function saveConn(env, sk, userId, provider, method, key, model) {
  const secret = await seal(sk, userId, key);
  // keep the user's access choice across reconnects; new connections start at "this canvas"
  await env.DB.prepare(
    `INSERT INTO ai_connections (user_id, provider, method, secret, hint, model, scope, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'canvas', 'ok', ?)
     ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, method = excluded.method, secret = excluded.secret, hint = excluded.hint,
       model = excluded.model, status = 'ok', created_at = excluded.created_at`
  ).bind(userId, provider, method, secret, key.slice(-4), model, Date.now()).run();
}

const safeReturn = (r) => (typeof r === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(r) ? r : '/settings');
const withParam = (path, kv) => {
  const [p, h = ''] = path.split('#');
  return p + (p.includes('?') ? '&' : '?') + kv + (h ? '#' + h : '');
};
const pkceCookie = (v, maxAge) => `ai_pkce=${v}; Path=/api/ai/openrouter; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/* ---------- routes ---------- */
export async function aiRoutes(req, env, ctx, url, user, body) {
  const path = url.pathname, method = req.method;
  const sk = await sealKey(env);

  if (path === '/api/ai' && method === 'GET') {
    return json({
      available: !!sk,
      connection: summary(await getConn(env, user.id)),
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, signIn: !!p.signIn, keysUrl: p.keysUrl })),
    });
  }
  if (path === '/api/ai' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM ai_connections WHERE user_id = ?').bind(user.id).run();
    return json({ connection: null });
  }
  if (!sk) return fail(503, "AI connections aren't set up on this server yet.");

  if (path === '/api/ai/openrouter/start' && method === 'GET') {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
    const ret = safeReturn(url.searchParams.get('return'));
    const auth = env.AI_TEST_BASE ? `${env.AI_TEST_BASE}/openrouter-auth` : 'https://openrouter.ai/auth';
    const to = `${auth}?callback_url=${encodeURIComponent(url.origin + '/api/ai/openrouter/callback')}&code_challenge=${challenge}&code_challenge_method=S256`;
    return redirect(to, { 'set-cookie': pkceCookie(`${verifier}|${encodeURIComponent(ret)}`, 900) });
  }

  if (path === '/api/ai/openrouter/callback' && method === 'GET') {
    const raw = (req.headers.get('cookie') || '').match(/(?:^|;\s*)ai_pkce=([^;]+)/)?.[1];
    const clear = { 'set-cookie': pkceCookie('', 0) };
    if (!raw) return redirect(withParam('/settings', 'ai_error=expired'), clear);
    const [verifier, retEnc] = raw.split('|');
    const ret = safeReturn(decodeURIComponent(retEnc || ''));
    const code = url.searchParams.get('code');
    if (!code) return redirect(withParam(ret, 'ai_error=cancelled'), clear);
    let key;
    try {
      const res = await fetch(baseOf(env, 'openrouter') + '/auth/keys', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      });
      key = res.ok ? (await res.json()).key : null;
    } catch {}
    if (!key) return redirect(withParam(ret, 'ai_error=exchange'), clear);
    try {
      const { model } = await checkConnection(env, 'openrouter', key);
      await saveConn(env, sk, user.id, 'openrouter', 'oauth', key, model);
    } catch (e) {
      return redirect(withParam(ret, `ai_error=${e.kind === 'auth' ? 'denied' : 'check'}`), clear);
    }
    return redirect(withParam(ret, 'ai=connected'), clear);
  }

  if (path === '/api/ai/key' && method === 'POST') {
    const p = body.provider, key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!PROVIDERS[p]) return fail(400, 'Choose a provider.');
    if (key.length < 10 || key.length > 400 || /\s/.test(key)) return fail(400, 'That doesn\'t look like an API key. Paste the whole key.');
    try {
      const { models, model } = await checkConnection(env, p, key);
      await saveConn(env, sk, user.id, p, 'api_key', key, model);
      return json({ connection: summary(await getConn(env, user.id)), models });
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      return fail(e.kind === 'auth' ? 400 : 502, e.kind === 'auth' ? `${PROVIDERS[p].label} didn't accept that key. Check it and try again.` : e.message, { kind: e.kind });
    }
  }

  const conn = await getConn(env, user.id);
  if (!conn) return fail(409, 'Connect an AI provider first.', { kind: 'none' });

  if (path === '/api/ai' && method === 'PATCH') {
    const model = body.model === undefined ? conn.model : String(body.model).slice(0, 200).trim();
    const scope = body.scope === undefined ? conn.scope : body.scope;
    if (!model) return fail(400, 'Choose a model.');
    if (!SCOPES.includes(scope)) return fail(400, 'Choose what AI can read.');
    await env.DB.prepare('UPDATE ai_connections SET model = ?, scope = ? WHERE user_id = ?').bind(model, scope, user.id).run();
    return json({ connection: summary({ ...conn, model, scope }) });
  }

  const key = () => unseal(sk, user.id, conn.secret);

  if (path === '/api/ai/models' && method === 'GET') {
    try {
      return json({ models: await listModels(env, conn.provider, await key()) });
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.kind === 'auth') await markReconnect(env, user.id);
      return fail(502, e.message, { kind: e.kind });
    }
  }

  if (path === '/api/ai/ask' && method === 'POST') {
    if (conn.status === 'reconnect') return fail(409, `Your ${PROVIDERS[conn.provider].label} connection needs to be reconnected.`, { kind: 'auth' });
    const scope = body.scope, action = body.action || 'ask';
    if (!SCOPES.includes(scope)) return fail(400, 'Choose what AI should read.');
    if (SCOPES.indexOf(scope) > SCOPES.indexOf(conn.scope)) {
      return fail(403, `Your AI settings don't allow reading ${SCOPE_LABEL[scope]}. Change this in Settings → AI.`, { kind: 'scope' });
    }
    if (!ACTIONS.includes(action)) return fail(400, 'Unknown request.');
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 4000) : '';
    if (action === 'ask' && !question) return fail(400, 'Type a question.');
    const noteId = typeof body.noteId === 'string' ? body.noteId : '';
    if (scope !== 'all') {
      const own = await env.DB.prepare('SELECT 1 FROM notes WHERE id = ? AND user_id = ?').bind(noteId, user.id).first();
      if (!own) return fail(404, 'Canvas not found.');
    }
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((x) => typeof x === 'string').slice(0, 300) : [];
    if (scope === 'selection' && !itemIds.length) return fail(400, 'Select something on the canvas first.');
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));

    const day = new Date().toISOString().slice(0, 10);
    const used = await env.DB.prepare(
      'INSERT INTO ai_usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET n = n + 1 RETURNING n'
    ).bind(user.id, day).first('n');
    if (used > DAILY_CAP) return fail(429, `You've used today's ${DAILY_CAP} AI requests. The limit resets at midnight UTC.`, { kind: 'cap' });

    const sources = await retrieve(env, user.id, { scope, noteId, itemIds, question });
    const { system, user: content } = buildPrompt(sources, { scope, action, question, tz: body.tz });
    const apiKey = await key();

    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const send = (o) => w.write(enc.encode(JSON.stringify(o) + '\n'));
    ctx.waitUntil((async () => {
      try {
        await send({
          t: 'sources', provider: PROVIDERS[conn.provider].label, model: conn.model,
          sources: sources.map((s, i) => ({ n: i + 1, id: s.id, noteId: s.noteId, title: s.title, updated: s.updated, excerpt: s.text.slice(0, 160) })),
        });
        for await (const text of streamChat(env, conn.provider, apiKey, conn.model, system, [...history, { role: 'user', content }])) await send({ t: 'delta', text });
        await send({ t: 'done' });
      } catch (e) {
        if (e.kind === 'auth') await markReconnect(env, user.id);
        if (!(e instanceof ProviderError)) console.error(e);
        await send({ t: 'error', kind: e.kind || 'server', error: e instanceof ProviderError ? e.message : 'Something went wrong while answering. Try again.' }).catch(() => {});
      } finally {
        await w.close().catch(() => {});
      }
    })());
    return new Response(readable, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
  }

  return fail(404, 'Not found.');
}
