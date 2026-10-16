// Ask AI panel. Uses note.js globals: noteId, items, selection, setSelection, selBounds, commit, focusItem,
// toWorld, board, pending, flush, saveTimer, retryDelay, stopped, closeMenu.
// Model output is untrusted: it is only ever inserted as text nodes.
const aiPanel = $('#ai');
const SCOPE_ORDER = ['selection', 'canvas', 'all'];
const ACTION_LABEL = { summarize: 'Summarize the selection', plan: 'Make a plan from the selection', develop: 'Develop the idea in the selection' };
const aiHistory = []; // this visit's turns, sent back for follow-up questions
let aiState = null;
let aiBusy = null;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') n.onclick = v;
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}
const aiReturn = () => '/note?id=' + encodeURIComponent(noteId);
const orStart = () => '/api/ai/openrouter/start?return=' + encodeURIComponent(aiReturn());

async function loadAIState() {
  try { aiState = await api('/api/ai'); } catch (e) { aiState = { error: e.message }; }
  renderAI();
}

function emptyState(title, text, ...actions) {
  const box = $('#ai-empty');
  box.replaceChildren(el('h3', {}, title), el('p', {}, text), ...actions);
  box.hidden = false;
  $('#ai-foot').hidden = true;
}

function renderAI() {
  const c = aiState?.connection;
  $('#ai-model').textContent = c ? `${c.label} · ${c.model}` : '';
  if (aiState?.error) return emptyState("Couldn't load your AI settings", aiState.error, el('button', { class: 'btn', onclick: loadAIState }, 'Try again'));
  if (!aiState.available) return emptyState('AI is not available yet', "AI connections aren't set up on this server yet. Everything else on your canvas works as usual.");
  if (!c) {
    return emptyState('Connect your AI',
      'Bring the AI you already use. Ask about what you have written here, summarize a selection, or turn notes into a plan. Nothing is sent until you ask.',
      el('a', { class: 'btn primary', href: orStart() }, 'Continue with OpenRouter'),
      el('a', { href: '/settings' }, 'Other options, including API keys, in Settings'));
  }
  if (c.status === 'reconnect') {
    return emptyState('Reconnect your AI', `${c.label} stopped accepting this connection. It may have been revoked or expired.`,
      c.method === 'oauth' ? el('a', { class: 'btn primary', href: orStart() }, 'Reconnect with OpenRouter') : el('a', { class: 'btn primary', href: '/settings' }, 'Enter a new key in Settings'));
  }
  $('#ai-empty').hidden = true;
  $('#ai-foot').hidden = false;
  pickScope();
}

const allowedScopes = () => {
  const c = aiState?.connection;
  return c ? SCOPE_ORDER.slice(0, SCOPE_ORDER.indexOf(c.scope) + 1) : [];
};
const currentScope = () => document.querySelector('input[name=ai-scope]:checked')?.value;

function pickScope() {
  const allowed = allowedScopes();
  const want = selection.size ? 'selection' : allowed.includes('canvas') ? 'canvas' : allowed.includes('all') ? 'all' : null;
  for (const r of document.querySelectorAll('input[name=ai-scope]')) {
    r.disabled = !allowed.includes(r.value) || (r.value === 'selection' && !selection.size);
    r.checked = r.value === want && !r.disabled;
  }
  updateFoot();
}

function updateFoot() {
  const c = aiState?.connection, scope = currentScope();
  $('#ai-actions').hidden = scope !== 'selection';
  $('#ai-q').placeholder = { selection: 'Ask about the selection…', canvas: 'Ask about this canvas…', all: "Ask about anything you've written…" }[scope] || 'Select notes to ask about them';
  const what = { selection: `the ${selection.size} selected item${selection.size === 1 ? '' : 's'}`, canvas: 'this canvas', all: 'all your canvases' }[scope];
  $('#ai-note').textContent = !c ? '' : scope
    ? `Sends your question and the typed text from ${what} to ${c.label}. Handwriting isn't sent.`
    : 'Your settings let AI read only what you select. Select notes on the canvas first.';
  $('#ai-send').disabled = !scope || !!aiBusy;
  for (const b of document.querySelectorAll('#ai-actions .btn')) b.disabled = !!aiBusy;
}
for (const r of document.querySelectorAll('input[name=ai-scope]')) r.onchange = updateFoot;

window.openAI = function openAI() {
  closeMenu();
  aiPanel.hidden = false;
  $('#ai-open').setAttribute('aria-expanded', 'true');
  loadAIState().then(() => { if (!$('#ai-foot').hidden && matchMedia('(pointer: fine)').matches) $('#ai-q').focus({ preventScroll: true }); });
};
function closeAI() {
  aiPanel.hidden = true;
  $('#ai-open').setAttribute('aria-expanded', 'false');
  aiBusy?.abort();
}
$('#ai-open').onclick = () => (aiPanel.hidden ? openAI() : closeAI());
$('#ai-close').onclick = closeAI;
$('#sel-ai').onclick = () => openAI();

// keep the scope in step with what's selected while the panel is open
const baseSetSelection = setSelection;
setSelection = function (ids) {
  baseSetSelection(ids);
  if (!aiPanel.hidden && aiState?.connection && !aiBusy) pickScope();
};

/* ---------- asking ---------- */
function paintAnswer(node, text, sources) {
  const parts = text.split(/(\[\d+\])/g);
  node.replaceChildren(...parts.map((part) => {
    const n = Number(part.match(/^\[(\d+)\]$/)?.[1]);
    const s = n && sources[n - 1];
    return s ? el('button', { class: 'cite', type: 'button', title: s.title, onclick: () => openSource(s) }, String(n)) : document.createTextNode(part);
  }));
}

function openSource(s) {
  if (s.noteId === noteId) {
    if (!focusItem(s.id)) toast('That note has since been deleted.');
  } else {
    location.href = '/note?id=' + encodeURIComponent(s.noteId) + '#item-' + s.id;
  }
}

function sourceList(sources) {
  if (!sources.length) return el('p', { class: 'sources' }, 'No typed notes were found in this scope.');
  return el('details', { class: 'sources' },
    el('summary', {}, `Based on ${sources.length} note${sources.length === 1 ? '' : 's'}`),
    el('ol', {}, ...sources.map((s) => el('li', {}, el('button', { type: 'button', onclick: () => openSource(s) }, s.excerpt + (s.excerpt.length >= 160 ? '…' : '')),
      aiState.connection.scope === 'all' ? ` · ${s.title}` : null))));
}

function addToCanvas(text) {
  const clean = text.replace(/\s*\[\d+\]/g, '').trim();
  const sb = selBounds();
  const [wx, wy] = sb ? [sb.x1 + 40, sb.y0] : toWorld((board.clientWidth - (innerWidth > 640 ? 424 : 0)) / 2 - 180, board.clientHeight * 0.25);
  const it = { id: crypto.randomUUID(), kind: 'text', t: Date.now(), x: Math.round(wx), y: Math.round(wy), w: 360, s: 16, c: 'ink', text: clean };
  commit([{ id: it.id, before: null, after: it }]);
  requestAnimationFrame(() => focusItem(it.id));
  toast('Added to your canvas. Undo removes it.');
}

async function saveFirst() {
  // the AI reads saved text, so unsent edits go first
  clearTimeout(saveTimer);
  for (let i = 0; i < 10 && pending.size && !stopped; i++) {
    await flush();
    if (retryDelay) break;
  }
  return !pending.size;
}

const NEXT_STEP = {
  credits: ['Open Settings', '/settings'],
  model: ['Choose a model in Settings', '/settings'],
  scope: ['Change access in Settings', '/settings'],
};

async function ask(action, question) {
  const scope = currentScope(), c = aiState?.connection;
  if (!scope || !c || aiBusy) return;
  const asked = action === 'ask' ? question : ACTION_LABEL[action] + (question ? `: ${question}` : '');
  const answer = el('div', { class: 'text', 'aria-live': 'polite' });
  const msg = el('li', { class: 'msg-a' }, answer);
  $('#ai-log').append(el('li', { class: 'msg-q' }, asked), msg);
  msg.scrollIntoView({ block: 'end' });

  aiBusy = new AbortController();
  updateFoot();
  let text = '', sources = [], error = null, done = false;
  try {
    if (!(await saveFirst())) throw Object.assign(new Error("Your latest edits haven't saved yet, so the AI would read an older version. Check your connection and try again."), { kind: 'save' });
    const res = await fetch('/api/ai/ask', {
      method: 'POST', signal: aiBusy.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action, question, scope, noteId, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        itemIds: scope === 'selection' ? [...selection] : undefined,
        history: action === 'ask' ? aiHistory.slice(-6) : [],
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || 'The AI request failed. Try again.'), { kind: j.kind });
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.t === 'sources') sources = m.sources;
        else if (m.t === 'delta') { text += m.text; paintAnswer(answer, text, sources); }
        else if (m.t === 'error') error = Object.assign(new Error(m.error), { kind: m.kind });
        else if (m.t === 'done') done = true;
      }
    }
    if (error) throw error;
    if (!done) throw Object.assign(new Error('The answer was cut off. Try again.'), { kind: 'network' });
  } catch (e) {
    error = e.name === 'AbortError' ? Object.assign(new Error('Stopped.'), { kind: 'stopped' }) : e;
    if (e.kind === undefined && e.name !== 'AbortError' && !e.message) error.message = "Couldn't reach ThinkSL8. Check your connection.";
  } finally {
    aiBusy = null;
  }

  if (text) msg.append(sourceList(sources));
  if (error) {
    const next = NEXT_STEP[error.kind];
    msg.append(el('p', { class: error.kind === 'stopped' ? 'ai-note' : 'notice error' }, error.message, next ? ' ' : null, next ? el('a', { href: next[1] }, next[0]) : null));
    if (error.kind === 'auth') { aiState.connection.status = 'reconnect'; setTimeout(renderAI, 1500); }
  }
  if (text && !error) {
    aiHistory.push({ role: 'user', content: asked }, { role: 'assistant', content: text });
    msg.append(el('div', { class: 'msg-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => addToCanvas(text) }, 'Add to canvas'),
      el('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard.writeText(text.replace(/\s*\[\d+\]/g, '')).then(() => toast('Copied.'), () => toast("Couldn't copy. Select the text instead.")) }, 'Copy')));
  }
  msg.scrollIntoView({ block: 'end' });
  updateFoot();
}

$('#ai-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#ai-q').value.trim();
  if (!q) return $('#ai-q').focus();
  $('#ai-q').value = '';
  $('#ai-q').style.height = '';
  ask('ask', q);
});
$('#ai-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#ai-form').requestSubmit(); }
});
$('#ai-q').addEventListener('input', () => {
  const t = $('#ai-q');
  t.style.height = '';
  t.style.height = Math.min(t.scrollHeight + 2, 140) + 'px';
});
for (const b of document.querySelectorAll('#ai-actions [data-action]')) {
  b.onclick = () => {
    const extra = $('#ai-q').value.trim();
    $('#ai-q').value = '';
    ask(b.dataset.action, extra);
  };
}
