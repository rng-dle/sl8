// Canvas alerts: when a connected AI (through the MCP connector) adds or changes something on a canvas, wake a Claude routine
// through its API trigger and/or email the owner. A cooldown keeps bursts to one call; what lands inside it is sent by the
// next call, which the scheduled handler (every few minutes) makes if no newer write does. Settings live at /alerts.
import { currentUser } from './worker.js';
import { canSendMail, sendMail } from './mail.js';
import { sealKey, seal, unseal } from './ai.js';

const ROUTINE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]{4,80}\/fire$/;
const NTFY = /^https:\/\/ntfy\.sh\/[A-Za-z0-9_-]{12,64}$/;
const MAX_HOOKS = 20;
const origin = (env) => (env.MCP_RESOURCE ? new URL(env.MCP_RESOURCE).origin : 'https://thinksl8.com');
const okUrl = (env, u) => ROUTINE.test(u) || (!!env.TEST_BASE && u.startsWith(env.TEST_BASE + '/routines/') && u.endsWith('/fire'));
const minCooldown = (env) => (env.TEST_BASE ? 1 : 30);
const okTopic = (env, u) => NTFY.test(u) || (!!env.TEST_BASE && /^[^?#]+\/ntfy\/[A-Za-z0-9_-]{12,64}$/.test(u) && u.startsWith(env.TEST_BASE + '/ntfy/'));
const newTopic = (env) => `${env.TEST_BASE ? env.TEST_BASE + '/ntfy' : 'https://ntfy.sh'}/thinksl8-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const firstLine = (t) => String(t || '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) || '(no text)';
const matches = (hook, texts) => {
  const words = hook.match.split('|').map((w) => w.trim()).filter(Boolean);
  if (!words.length) return texts[0] ?? '';
  return texts.find((t) => words.some((w) => t.includes(w)));
};

async function fire(env, hook, summary) {
  const note = await env.DB.prepare('SELECT title FROM notes WHERE id = ?').bind(hook.note_id).first();
  const title = note?.title || 'a canvas';
  const link = `${origin(env)}/note?id=${hook.note_id}`;
  let status;
  try {
    if (hook.kind === 'routine') {
      const key = await sealKey(env);
      if (!key) throw new Error('server has no KEY_ENC_SECRET');
      const token = await unseal(key, hook.user_id, hook.secret);
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ text: `ThinkSL8 alert: something new on the canvas "${title}" (canvas_id ${hook.note_id}). Latest: ${summary}` }),
      });
      status = res.ok ? 'woke the routine' : `routine returned ${res.status}: ${(await res.text()).slice(0, 120)}`;
    } else if (hook.kind === 'push') {
      // ntfy: JSON publishing to the server root, so titles and messages can hold any characters.
      const at = hook.url.lastIndexOf('/');
      const headers = { 'content-type': 'application/json' };
      // An ntfy access token makes pushes count against the user's ntfy account instead of the shared Cloudflare address, which ntfy.sh rate-limits (429).
      if (hook.secret) {
        const key = await sealKey(env);
        if (!key) throw new Error('server has no KEY_ENC_SECRET');
        headers.authorization = 'Bearer ' + (await unseal(key, hook.user_id, hook.secret));
      }
      const res = await fetch(hook.url.slice(0, at), {
        method: 'POST',
        headers,
        body: JSON.stringify({ topic: hook.url.slice(at + 1), title: `ThinkSL8 · ${title}`.slice(0, 120), message: summary, click: link, tags: ['speech_balloon'] }),
      });
      status = res.ok ? 'pushed to your phone' : `ntfy returned ${res.status}${res.status === 429 ? ' (rate limited: add an ntfy access token to this alert)' : res.status === 401 || res.status === 403 ? ' (token not accepted)' : ''}`;
    } else {
      if (!canSendMail(env)) throw new Error("email isn't set up on this server yet");
      const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(hook.user_id).first();
      if (!user) throw new Error('no such user');
      await sendMail(env, {
        to: user.email,
        subject: `ThinkSL8: ${summary.slice(0, 90)}`,
        text: `Something new on "${title}":\n\n${summary}\n\nOpen it: ${link}\n\nManage these alerts: ${origin(env)}/alerts`,
        html: `<div style="font:16px/1.5 system-ui,sans-serif;color:#191c29;max-width:480px"><p>Something new on <b>${esc(title)}</b>:</p><p style="padding:10px 14px;background:#f1f3fa;border-radius:10px">${esc(summary)}</p><p><a href="${link}">Open the canvas</a> · <a href="${origin(env)}/alerts">Manage alerts</a></p></div>`,
      });
      status = 'emailed';
    }
  } catch (e) {
    status = 'failed: ' + String(e.message || e).slice(0, 160);
  }
  await env.DB.prepare('UPDATE canvas_hooks SET last_fired_at = ?, pending_since = NULL, pending_note = NULL, last_status = ? WHERE id = ?').bind(Date.now(), status, hook.id).run();
  return status;
}

// Called after the connector writes. texts: the text of what was added or changed (typed note text, transcript, or a label).
export async function onAiWrite(env, userId, noteId, texts) {
  const { results } = await env.DB.prepare('SELECT * FROM canvas_hooks WHERE note_id = ? AND user_id = ?').bind(noteId, userId).all();
  const now = Date.now();
  for (const hook of results) {
    const hit = matches(hook, texts);
    if (hit === undefined) continue;
    const summary = firstLine(hit);
    if (!hook.last_fired_at || now - hook.last_fired_at >= hook.cooldown * 1000) await fire(env, hook, summary);
    else await env.DB.prepare('UPDATE canvas_hooks SET pending_since = COALESCE(pending_since, ?), pending_note = ? WHERE id = ?').bind(now, summary, hook.id).run();
  }
}

// The scheduled handler: send whatever waited out a cooldown.
export async function firePending(env) {
  const { results } = await env.DB.prepare('SELECT * FROM canvas_hooks WHERE pending_since IS NOT NULL AND (last_fired_at IS NULL OR last_fired_at + cooldown * 1000 <= ?) LIMIT 50').bind(Date.now()).all();
  for (const hook of results) await fire(env, hook, hook.pending_note || '(changes)');
}

/* ---------- the settings page ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alerts · ThinkSL8</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:6vh auto;padding:0 1rem;color:#1b1f24}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
input,select,button{font:inherit;padding:.5rem .7rem;border-radius:.5rem;border:1px solid #888;background:#fff;color:inherit;max-width:100%;box-sizing:border-box}
label{display:block;margin:.8rem 0 .2rem}input[type=text],input[type=password],input[type=url],select{width:100%}.hook{border:1px solid #ccc;border-radius:.7rem;padding:.7rem 1rem;margin:.6rem 0}
.muted{color:#667;font-size:.9rem}button.go{background:#1a73e8;color:#fff;border-color:#1a73e8}form.inline{display:inline}
@media(prefers-color-scheme:dark){body{background:#14161a;color:#eee}input,select,button{background:#22262c}.hook{border-color:#444}.muted{color:#99a}}</style>${body}`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });

export async function alertsPage(req, env) {
  const url = new URL(req.url);
  if (url.pathname !== '/alerts') return null;
  const user = await currentUser(req, env);
  if (!user) return page(`<h1>Sign in first</h1><p><a href="/">Open ThinkSL8</a>, sign in, then come back to this page.</p>`, 401);
  let flash = '';
  if (req.method === 'POST') {
    if (req.headers.get('origin') !== url.origin) return page('<h1>Not allowed</h1>', 403);
    const f = await req.formData();
    const action = f.get('action');
    if (action === 'add') flash = await addHook(env, user, f);
    else if (action === 'delete') {
      await env.DB.prepare('DELETE FROM canvas_hooks WHERE id = ? AND user_id = ?').bind(String(f.get('id')), user.id).run();
      flash = 'Alert removed.';
    } else if (action === 'test') {
      const hook = await env.DB.prepare('SELECT * FROM canvas_hooks WHERE id = ? AND user_id = ?').bind(String(f.get('id')), user.id).first();
      flash = hook ? 'Test: ' + (await fire(env, hook, 'Test alert from the ThinkSL8 alerts page')) : 'No such alert.';
    } else return page('<h1>Not allowed</h1>', 400);
  } else if (req.method !== 'GET') return page('<h1>Not allowed</h1>', 405);

  const [{ results: canvases }, { results: hooks }] = await env.DB.batch([
    env.DB.prepare('SELECT id, title FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300').bind(user.id),
    env.DB.prepare('SELECT h.*, n.title FROM canvas_hooks h LEFT JOIN notes n ON n.id = h.note_id WHERE h.user_id = ? ORDER BY h.created_at').bind(user.id),
  ]);
  const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never');
  const list = hooks.map((h) => `<div class="hook"><b>${esc(h.label || (h.kind === 'routine' ? 'Claude routine' : h.kind === 'push' ? 'Push to my phone' : 'Email me'))}</b> on <i>${esc(h.title || 'deleted canvas')}</i>
<div class="muted">${h.kind === 'routine' ? 'Wakes a Claude routine' : h.kind === 'push' ? `Pushes to the ntfy topic <b>${esc(h.url.slice(h.url.lastIndexOf('/') + 1))}</b>${h.secret ? ' with your ntfy token' : ''}` : 'Emails ' + esc(user.email)}${h.match ? ` · only when the text contains ${esc(h.match.split('|').join(' or '))}` : ''} · at most every ${h.cooldown} s<br>Last: ${when(h.last_fired_at)}${h.last_status ? ' · ' + esc(h.last_status) : ''}${h.pending_since ? ' · one waiting' : ''}</div>
<form class="inline" method="post"><input type="hidden" name="id" value="${esc(h.id)}"><button name="action" value="test">Send a test</button> <button name="action" value="delete">Remove</button></form></div>`).join('') || '<p class="muted">No alerts yet.</p>';
  const opts = canvases.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
  return page(`<h1>Alerts</h1><p class="muted">When an AI connected to ThinkSL8 adds or changes something on a canvas, ThinkSL8 can wake a Claude routine or email you. Your own edits in the app don't trigger alerts.</p>
${flash ? `<p><b>${esc(flash)}</b></p>` : ''}${list}
<h2>Add an alert</h2>
<form method="post"><input type="hidden" name="action" value="add">
<label for="c">Canvas</label><select id="c" name="note_id" required>${opts}</select>
<label for="k">What happens</label><select id="k" name="kind"><option value="push">Push to my phone (ntfy app)</option><option value="routine">Wake a Claude routine</option><option value="email">Email me${canSendMail(env) ? '' : " (email isn't set up on this server yet)"}</option></select>
<label for="l">Name (optional)</label><input id="l" type="text" name="label" maxlength="80" placeholder="Wake claude-ai">
<label for="n">ntfy topic (for a phone push; leave empty and one is made for you)</label><input id="n" type="text" name="topic" maxlength="64" placeholder="thinksl8-…">
<label for="nt">ntfy access token (optional, fixes "ntfy returned 429")</label><input id="nt" type="password" name="ntfytoken" autocomplete="off" placeholder="tk_…">
<p class="muted">Install the free ntfy app, then subscribe to the topic shown on the alert after you add it. Anyone who knows the topic name can read these pushes, so keep it private. ntfy.sh limits requests per address and this server shares its address, so if pushes fail with 429, make a free ntfy.sh account, create an access token (Account, Access tokens) and paste it here. It is stored encrypted and never shown again.</p>
<label for="u">Routine URL (for a routine)</label><input id="u" type="url" name="url" placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire">
<label for="t">Routine token (for a routine)</label><input id="t" type="password" name="token" autocomplete="off" placeholder="sk-ant-oat01-…">
<p class="muted">In claude.ai/code/routines, open the routine, add an API trigger and generate a token. Paste the URL and token here. The token is stored encrypted and never shown again.</p>
<label for="m">Only when the text contains (optional, separate with |)</label><input id="m" type="text" name="match" maxlength="300" placeholder="TO: claude-ai">
<label for="cd">At most one alert every (seconds)</label><input id="cd" type="number" name="cooldown" min="${minCooldown(env)}" max="86400" value="120">
<p><button class="go">Add alert</button></p></form>`);
}

async function addHook(env, user, f) {
  const noteId = String(f.get('note_id') || '');
  const kind = ['email', 'push'].includes(f.get('kind')) ? f.get('kind') : 'routine';
  const label = String(f.get('label') || '').trim().slice(0, 80);
  const match = String(f.get('match') || '').trim().slice(0, 300);
  const cooldown = Math.min(86400, Math.max(minCooldown(env), Math.round(Number(f.get('cooldown')) || 120)));
  if (!(await env.DB.prepare('SELECT 1 FROM notes WHERE id = ? AND user_id = ?').bind(noteId, user.id).first())) return 'Pick one of your canvases.';
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM canvas_hooks WHERE user_id = ?').bind(user.id).first('n');
  if (n >= MAX_HOOKS) return `You already have ${MAX_HOOKS} alerts.`;
  let url = null, secret = null;
  if (kind === 'push') {
    const t = String(f.get('topic') || '').trim().replace(/^https:\/\/ntfy\.sh\//, '');
    url = t ? `${env.TEST_BASE ? env.TEST_BASE + '/ntfy' : 'https://ntfy.sh'}/${t}` : newTopic(env);
    if (!okTopic(env, url)) return 'Use a topic of 12 to 64 letters, digits, - or _ (or leave it empty).';
    const token = String(f.get('ntfytoken') || '').trim();
    if (token) {
      if (!/^[\w.-]{20,400}$/.test(token)) return "That doesn't look like an ntfy access token (it starts with tk_).";
      const key = await sealKey(env);
      if (!key) return "This server can't store tokens safely yet (no KEY_ENC_SECRET).";
      secret = await seal(key, user.id, token);
    }
  }
  if (kind === 'routine') {
    url = String(f.get('url') || '').trim();
    const token = String(f.get('token') || '').trim();
    if (!okUrl(env, url)) return 'That routine URL looks wrong. It should look like https://api.anthropic.com/v1/claude_code/routines/trig_…/fire';
    if (!/^[\w.-]{20,400}$/.test(token)) return 'Paste the routine token too.';
    const key = await sealKey(env);
    if (!key) return "This server can't store tokens safely yet (no KEY_ENC_SECRET).";
    secret = await seal(key, user.id, token);
  }
  await env.DB.prepare('INSERT INTO canvas_hooks (id, user_id, note_id, kind, label, url, secret, match, cooldown, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, noteId, kind, label, url, secret, match, cooldown, Date.now()).run();
  return kind === 'push' ? `Alert added. In the ntfy app, subscribe to the topic ${url.slice(url.lastIndexOf('/') + 1)}` : 'Alert added.';
}
