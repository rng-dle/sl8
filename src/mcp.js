// The ThinkSL8 MCP connector: lets a user's own AI (Claude and others) read their canvases and voice notes, and, if they allow it, add
// canvases, typed notes, portals, recordings and transcripts ("canvas:write"), and, as a separate approval, edit, move, rename and delete ("canvas:edit"). Built on Cloudflare's workers-oauth-provider (OAuth 2.1, MIT) and agents' createMcpHandler (stateless).
import { WorkerEntrypoint } from 'cloudflare:workers';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { currentUser, saveOps, saved, sniffVideo, sniffAudio, fileKey, MAX_FILES } from './worker.js';
import { onAiWrite } from './hooks.js';

const MAX_AUDIO = 2_000_000; // decoded bytes an AI may add or fetch in one call
const out = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });
const err = (m) => ({ isError: true, content: [{ type: 'text', text: m }] });
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const owns = (env, userId, noteId) => env.DB.prepare('SELECT title FROM notes WHERE id = ? AND user_id = ?').bind(noteId, userId).first();
const NEED_WRITE = 'This connection is read-only. Reconnect ThinkSL8 and tick "allow adding recordings and transcripts" to use this tool.';

function buildServer(env, ctx, { userId, scopes = [] }) {
  const canWrite = scopes.includes('canvas:write');
  const s = new McpServer({ name: 'thinksl8', version: '1.0.0' });
  const save = async (noteId, ops) => (await saved(ctx, env, noteId, {}, saveOps(env, noteId, ops), ops)).ok;
  // Canvas alerts (/alerts): run after the reply so a slow routine or mail call never delays the tool.
  const alert = (noteId, ...texts) => ctx.waitUntil(onAiWrite(env, userId, noteId, texts.filter((t) => typeof t === 'string' && t)).catch(() => {}));
  // Where a new item goes when the AI gives no position: just below everything already on the canvas.
  const nextY = async (canvasId) => {
    const { results } = await env.DB.prepare("SELECT data FROM items WHERE note_id = ? AND json_extract(data, '$.kind') IN ('text', 'portal', 'voice')").bind(canvasId).all();
    let bottom = null;
    for (const r of results) {
      const it = JSON.parse(r.data);
      let b;
      if (it.kind === 'text') {
        const w = it.w || 320, sz = it.s || 17, lines = String(it.text || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(8, w / (sz * 0.55)))), 0);
        b = (it.y || 0) + lines * sz * 1.4;
      } else b = (it.y || 0) + (it.h || 132);
      if (bottom === null || b > bottom) bottom = b;
    }
    return bottom === null ? 0 : bottom + 24;
  };

  s.registerTool('list_canvases', { description: "List the user's ThinkSL8 canvases, newest first." }, async () => {
    const { results } = await env.DB.prepare('SELECT id, title, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').bind(userId).all();
    return out(results.map((r) => ({ id: r.id, title: r.title, updated: new Date(r.updated_at).toISOString() })));
  });

  s.registerTool('read_canvas', { description: "Read a canvas's typed notes, portals and voice notes (with transcripts). Handwriting is not included.", inputSchema: { canvas_id: z.string() } }, async ({ canvas_id }) => {
    const note = await owns(env, userId, canvas_id);
    if (!note) return err('No such canvas.');
    const { results } = await env.DB.prepare("SELECT data FROM items WHERE note_id = ? AND json_extract(data, '$.kind') IN ('text', 'voice', 'portal') ORDER BY updated_at").bind(canvas_id).all();
    const items = results.map((r) => { const it = JSON.parse(r.data); return it.kind === 'text' ? { id: it.id, kind: 'text', x: it.x, y: it.y, text: it.text } : it.kind === 'voice' ? { id: it.id, kind: 'voice', x: it.x, y: it.y, seconds: it.dur, transcript: it.text ?? null } : { id: it.id, kind: 'portal', opens_canvas: it.target, x: it.x, y: it.y }; });
    let body = JSON.stringify({ title: note.title, items });
    if (body.length > 60000) body = JSON.stringify({ title: note.title, truncated: true, items: items.slice(0, Math.max(1, Math.floor(items.length * 60000 / body.length))) });
    return out(body);
  });

  s.registerTool('search', { description: 'Search typed notes and voice transcripts across all canvases.', inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(30).optional() } }, async ({ query, limit = 10 }) => {
    const words = query.match(/[\p{L}\p{N}]+/gu) || [];
    if (!words.length) return out([]);
    const [typed, spoken] = await env.DB.batch([
      env.DB.prepare('SELECT i.note_id AS canvas_id, n.title, i.id AS item_id, json_extract(i.data, \'$.text\') AS text FROM items_fts f JOIN items i ON i.rowid = f.rowid JOIN notes n ON n.id = i.note_id WHERE items_fts MATCH ? AND n.user_id = ? ORDER BY rank LIMIT ?').bind(words.map((w) => `"${w}"`).join(' '), userId, limit),
      env.DB.prepare("SELECT i.note_id AS canvas_id, n.title, i.id AS item_id, json_extract(i.data, '$.text') AS text FROM items i JOIN notes n ON n.id = i.note_id WHERE n.user_id = ? AND json_extract(i.data, '$.kind') = 'voice' AND json_extract(i.data, '$.text') LIKE ? ESCAPE '\\' LIMIT ?").bind(userId, `%${words.join(' ').replace(/[\\%_]/g, '\\$&')}%`, limit),
    ]);
    const hit = (r, kind) => ({ canvas_id: r.canvas_id, canvas_title: r.title, item_id: r.item_id, kind, excerpt: String(r.text || '').slice(0, 300) });
    return out([...typed.results.map((r) => hit(r, 'text')), ...spoken.results.map((r) => hit(r, 'voice'))].slice(0, limit));
  });

  s.registerTool('get_voice_note', { description: 'Get a voice note: its length, transcript and, optionally, the audio itself (recordings up to 2 MB).', inputSchema: { canvas_id: z.string(), item_id: z.string(), include_audio: z.boolean().optional() } }, async ({ canvas_id, item_id, include_audio }) => {
    if (!(await owns(env, userId, canvas_id))) return err('No such canvas.');
    const row = await env.DB.prepare('SELECT data FROM items WHERE note_id = ? AND id = ?').bind(canvas_id, item_id).first('data');
    const it = row && JSON.parse(row);
    if (it?.kind !== 'voice') return err('No such voice note.');
    const res = [{ type: 'text', text: JSON.stringify({ id: it.id, seconds: it.dur, transcript: it.text ?? null }) }];
    if (include_audio) {
      const { value, metadata } = await env.FILES.getWithMetadata(fileKey(userId, it.file), 'arrayBuffer');
      if (!value) return err('The audio file is missing.');
      if (value.byteLength > MAX_AUDIO) res.push({ type: 'text', text: 'Audio is over 2 MB, so it was not included.' });
      else res.push({ type: 'audio', data: b64(new Uint8Array(value)), mimeType: metadata?.type || 'audio/webm' });
    }
    return { content: res };
  });

  s.registerTool('set_voice_transcript', { description: 'Write or replace the transcript of a voice note. Needs write access.', inputSchema: { canvas_id: z.string(), item_id: z.string(), transcript: z.string().max(40000) } }, async ({ canvas_id, item_id, transcript }) => {
    if (!canWrite) return err(NEED_WRITE);
    if (!(await owns(env, userId, canvas_id))) return err('No such canvas.');
    const row = await env.DB.prepare('SELECT data FROM items WHERE note_id = ? AND id = ?').bind(canvas_id, item_id).first('data');
    const it = row && JSON.parse(row);
    if (it?.kind !== 'voice') return err('No such voice note.');
    if (!(await save(canvas_id, [{ put: { ...it, text: transcript } }]))) return err('Could not save the transcript.');
    alert(canvas_id, transcript);
    return out('Transcript saved.');
  });

  s.registerTool('add_voice_note', { description: 'Add a voice note to a canvas from audio you have (WebM, MP4/M4A, Ogg, MP3 or WAV, base64, up to 2 MB), with an optional transcript. Needs write access.', inputSchema: { canvas_id: z.string(), audio_base64: z.string().max(2_800_000), transcript: z.string().max(40000).optional(), seconds: z.number().min(0).max(7200).optional(), x: z.number().optional(), y: z.number().optional() } }, async ({ canvas_id, audio_base64, transcript, seconds, x = 0, y = 0 }) => {
    if (!canWrite) return err(NEED_WRITE);
    if (!(await owns(env, userId, canvas_id))) return err('No such canvas.');
    let bytes;
    try { bytes = Uint8Array.from(atob(audio_base64), (c) => c.charCodeAt(0)); } catch { return err('The audio is not valid base64.'); }
    const type = sniffVideo(bytes) || sniffAudio(bytes);
    if (!type) return err('Unrecognised audio. Use WebM, MP4/M4A, Ogg, MP3 or WAV.');
    if (bytes.length > MAX_AUDIO) return err('Audio is over 2 MB.');
    const { keys } = await env.FILES.list({ prefix: `img:${userId}:` });
    if (keys.length >= MAX_FILES) return err("The user's file space is full.");
    const file = crypto.randomUUID();
    await env.FILES.put(fileKey(userId, file), bytes, { metadata: { type, size: bytes.length, at: Date.now() } });
    const item = { id: crypto.randomUUID(), kind: 'voice', t: Date.now(), file, x: Math.round(x), y: Math.round(y), w: 260, h: 52, ...(seconds != null && { dur: seconds }), ...(transcript && { text: transcript }) };
    if (!(await save(canvas_id, [{ put: item }]))) return err('Could not add the voice note.');
    alert(canvas_id, transcript, 'New voice note');
    return out({ added: item.id });
  });

  s.registerTool('create_canvas', { description: 'Create a new, empty canvas with the given title and return its id. Needs write access.', inputSchema: { title: z.string().min(1).max(200) } }, async ({ title }) => {
    if (!canWrite) return err(NEED_WRITE);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?').bind(userId).first('n');
    if (count >= 500) return err('The user already has 500 canvases.');
    const id = crypto.randomUUID(), now = Date.now(), clean = title.trim().slice(0, 200) || 'Untitled';
    await env.DB.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?)').bind(id, userId, clean, now, now).run();
    return out({ id, title: clean });
  });

  s.registerTool('add_note', { description: 'Add a typed text note to a canvas. Without x and y it lands below the existing notes. Needs write access.', inputSchema: { canvas_id: z.string(), text: z.string().min(1).max(40000), x: z.number().optional(), y: z.number().optional() } }, async ({ canvas_id, text, x, y }) => {
    if (!canWrite) return err(NEED_WRITE);
    if (!(await owns(env, userId, canvas_id))) return err('No such canvas.');
    const item = { id: crypto.randomUUID(), kind: 'text', t: Date.now(), x: Math.round(x ?? 0), y: Math.round(y ?? await nextY(canvas_id)), w: 320, s: 17, c: 'ink', text };
    if (!(await save(canvas_id, [{ put: item }]))) return err('Could not add the note.');
    alert(canvas_id, text);
    return out({ added: item.id });
  });

  s.registerTool('add_portal', { description: 'Add a portal card to a canvas that opens another of the user\'s canvases. Without x and y it lands below the existing items. Needs write access.', inputSchema: { canvas_id: z.string(), target_canvas_id: z.string(), x: z.number().optional(), y: z.number().optional() } }, async ({ canvas_id, target_canvas_id, x, y }) => {
    if (!canWrite) return err(NEED_WRITE);
    if (!(await owns(env, userId, canvas_id)) || !(await owns(env, userId, target_canvas_id))) return err('No such canvas.');
    const item = { id: crypto.randomUUID(), kind: 'portal', t: Date.now(), x: Math.round(x ?? 0), y: Math.round(y ?? await nextY(canvas_id)), w: 240, h: 132, target: target_canvas_id };
    if (!(await save(canvas_id, [{ put: item }]))) return err('Could not add the portal.');
    alert(canvas_id, 'New portal on the canvas');
    return out({ added: item.id });
  });

  // Editing and deleting need their own approval ("canvas:edit"), separate from adding.
  const NEED_EDIT = 'This connection cannot edit or delete. Reconnect ThinkSL8 and tick "allow editing and deleting" to use this tool.';
  const canEdit = scopes.includes('canvas:edit');
  const itemOf = async (canvasId, itemId) => { const row = await env.DB.prepare('SELECT data FROM items WHERE note_id = ? AND id = ?').bind(canvasId, itemId).first('data'); return row && JSON.parse(row); };

  s.registerTool('update_item', { description: 'Change the text of a typed note and/or move a typed note, portal or voice note. Item ids come from read_canvas. Checklist boxes are text, so tick one by editing its ☐ to ☑. Needs edit access.', inputSchema: { canvas_id: z.string(), item_id: z.string(), text: z.string().min(1).max(40000).optional(), x: z.number().optional(), y: z.number().optional() } }, async ({ canvas_id, item_id, text, x, y }) => {
    if (!canEdit) return err(NEED_EDIT);
    if (!(await owns(env, userId, canvas_id))) return err('No such canvas.');
    const it = await itemOf(canvas_id, item_id);
    if (!it || !['text', 'portal', 'voice'].includes(it.kind)) return err('No such note, portal or voice note.');
    if (text === undefined && x === undefined && y === undefined) return err('Nothing to change.');
    if (text !== undefined && it.kind !== 'text') return err('Only typed notes have text. Use set_voice_transcript for voice notes.');
    const next = { ...it, ...(text !== undefined && { text }), ...(x !== undefined && { x: Math.round(x) }), ...(y !== undefined && { y: Math.round(y) }) };
    if (!(await save(canvas_id, [{ put: next }]))) return err('Could not save the change.');
    alert(canvas_id, text, 'An item was moved');
    return out('Updated.');
  });

  s.registerTool('delete_item', { description: 'Delete one typed note, portal or voice note from a canvas. Item ids come from read_canvas. Needs edit access.', inputSchema: { canvas_id: z.string(), item_id: z.string() } }, async ({ canvas_id, item_id }) => {
    if (!canEdit) return err(NEED_EDIT);
    if (!(await owns(env, userId, canvas_id))) return err('No such canvas.');
    const it = await itemOf(canvas_id, item_id);
    if (!it || !['text', 'portal', 'voice'].includes(it.kind)) return err('No such note, portal or voice note.');
    if (!(await save(canvas_id, [{ del: item_id }]))) return err('Could not delete it.');
    alert(canvas_id, 'An item was deleted');
    return out('Deleted.');
  });

  s.registerTool('rename_canvas', { description: 'Change the title of a canvas. Needs edit access.', inputSchema: { canvas_id: z.string(), title: z.string().min(1).max(200) } }, async ({ canvas_id, title }) => {
    if (!canEdit) return err(NEED_EDIT);
    const clean = title.trim().slice(0, 200) || 'Untitled';
    const res = await env.DB.prepare('UPDATE notes SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(clean, Date.now(), canvas_id, userId).run();
    return res.meta?.changes ? out({ id: canvas_id, title: clean }) : err('No such canvas.');
  });
  return s;
}

// The API side: the provider has already checked the bearer token; ctx.props is what the user approved.
export class McpApi extends WorkerEntrypoint {
  fetch(request) {
    return createMcpHandler(() => buildServer(this.env, this.ctx, this.ctx.props), { route: '/mcp' })(request, this.env, this.ctx);
  }
}

// The sign-in and consent screen. The user must already be signed in to ThinkSL8 in this browser.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ThinkSL8</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.2rem;color:#1b1f24}h1{font-size:1.4rem}button,a.btn{font:inherit;padding:.6rem 1.1rem;border-radius:.6rem;border:1px solid #888;background:#fff;color:inherit;text-decoration:none;cursor:pointer;display:inline-block}button.go{background:#1a73e8;color:#fff;border-color:#1a73e8}label{display:block;margin:1rem 0}@media(prefers-color-scheme:dark){body{background:#14161a;color:#eee}button,a.btn{background:#22262c}}</style>${body}`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action *" } });

export async function authorize(req, env) {
  const url = new URL(req.url);
  if (url.pathname !== '/authorize') return null;
  let oauth;
  try { oauth = await env.OAUTH_PROVIDER.parseAuthRequest(req.method === 'POST' ? new Request(url.origin + '/authorize' + String((await req.clone().formData()).get('q') || '')) : req); }
  catch (e) { return page(`<h1>Can't connect</h1><p>${esc(e.message || 'This connection request is not valid.')}</p>`, 400); }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauth.clientId);
  const user = await currentUser(req, env);
  if (!user) return page(`<h1>Sign in first</h1><p>Open ThinkSL8 and sign in, then come back and reload this page to connect <b>${esc(client?.clientName || 'an app')}</b>.</p><p><a class="btn" href="/" target="_blank" rel="noopener">Open ThinkSL8</a> <a class="btn" href="">Reload</a></p>`, 401);
  if (req.method === 'GET') {
    return page(`<h1>Connect ${esc(client?.clientName || 'an app')} to ThinkSL8?</h1><p>Signed in as ${esc(user.email)}. This lets the app read your canvases, typed notes and voice notes (with transcripts). It never sees your password and you can stop it by deleting the connection in the app.</p>
<form method="post" action="/authorize"><input type="hidden" name="q" value="${esc(url.search)}">
<label><input type="checkbox" name="write" value="1"> Also allow creating canvases and adding typed notes, portals, voice notes and transcripts</label>
<label><input type="checkbox" name="edit" value="1"> Also allow editing, moving, renaming and deleting what is already there</label>
<button class="go" name="decision" value="allow">Allow</button> <button name="decision" value="deny">Cancel</button></form>`);
  }
  if (req.method !== 'POST' || req.headers.get('origin') !== url.origin) return page('<h1>Not allowed</h1>', 403);
  const form = await req.formData();
  if (form.get('decision') !== 'allow') {
    const back = new URL(oauth.redirectUri); back.searchParams.set('error', 'access_denied'); if (oauth.state) back.searchParams.set('state', oauth.state);
    return Response.redirect(back.toString(), 302);
  }
  const scopes = ['canvas:read', ...(form.get('write') ? ['canvas:write'] : []), ...(form.get('edit') ? ['canvas:edit'] : [])];
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: oauth, userId: user.id, metadata: { client: client?.clientName || '' }, scope: scopes, props: { userId: user.id, scopes } });
  return Response.redirect(redirectTo, 302);
}
