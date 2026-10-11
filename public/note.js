// ThinkSL8 canvas: infinite canvas with pressure ink, highlighter, eraser, text boxes and selection.
// Items live in world coordinates; the camera maps world -> screen as screen = world * z + (x, y).
// ai-panel.js loads after this file and uses its globals (items, selection, commit, focusItem, ...).
const $ = (s) => document.querySelector(s);
const noteId = new URLSearchParams(location.search).get('id');
const board = $('#board'), base = $('#base'), live = $('#live'), textsEl = $('#texts');
const bctx = base.getContext('2d'), lctx = live.getContext('2d');
const statusEl = $('#status'), titleEl = $('#title');

const COLORS = ['ink', 'blue', 'red', 'green', 'yellow'];
const SIZES = { pen: [1.5, 3, 6], hl: [12, 20, 32], text: [16, 22, 32] };
const BATCH = 40; // must match MAX_OPS on the server
const ERASER_PX = 10;

const tool = {
  name: 'select',
  color: store.get('sl8:color') || { pen: 'ink', hl: 'yellow', text: 'ink' },
  size: store.get('sl8:size') || { pen: 1, hl: 1, text: 1 },
};
const items = new Map(); // id -> item
const selection = new Set(); // ids of selected items
let sorted = null; // items ordered by creation time, rebuilt on demand
let cam = store.get('sl8:cam:' + noteId) || { x: 48, y: 96, z: 1 };
let palette = {};
let penSeen = !!store.get('sl8:penSeen');
let spaceDown = false;

/* ---------- drawing ---------- */
const pf = (pr) => 0.25 + 1.5 * pr; // pressure -> width factor
const bboxes = new WeakMap();
function bbox(s) {
  let b = bboxes.get(s);
  if (!b) {
    const p = s.p, pad = s.w * (s.pr ? 1.75 : 1) / 2;
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < p.length; i += 3) {
      b.x0 = Math.min(b.x0, p[i]); b.x1 = Math.max(b.x1, p[i]);
      b.y0 = Math.min(b.y0, p[i + 1]); b.y1 = Math.max(b.y1, p[i + 1]);
    }
    b.x0 -= pad; b.y0 -= pad; b.x1 += pad; b.y1 += pad;
    bboxes.set(s, b);
  }
  return b;
}

function drawStroke(ctx, s) {
  const p = s.p;
  const color = palette[s.c] || palette.ink;
  ctx.globalAlpha = s.hl ? palette.hlAlpha : 1;
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (p.length === 3) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], (s.pr ? s.w * pf(p[2]) : s.w) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (!s.pr) {
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 3; i < p.length - 3; i += 3) {
      ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 3]) / 2, (p[i + 1] + p[i + 4]) / 2);
    }
    ctx.lineTo(p[p.length - 3], p[p.length - 2]);
    ctx.stroke();
  } else {
    // variable width: one curve piece per point, from the previous midpoint to the next
    let px = p[0], py = p[1];
    for (let i = 3; i < p.length; i += 3) {
      const last = i >= p.length - 3;
      const mx = last ? p[i] : (p[i] + p[i + 3]) / 2, my = last ? p[i + 1] : (p[i + 1] + p[i + 4]) / 2;
      ctx.lineWidth = s.w * pf(p[i + 2]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
      ctx.stroke();
      px = mx; py = my;
    }
  }
  ctx.globalAlpha = 1;
}

function setCam(ctx) {
  const d = devicePixelRatio || 1;
  ctx.setTransform(d * cam.z, 0, 0, d * cam.z, d * cam.x, d * cam.y);
}
function clear(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

// ponytail: full redraw of visible strokes on every camera move; add tile caching if notes reach tens of thousands of strokes
function paintBase() {
  clear(bctx);
  setCam(bctx);
  const vx0 = -cam.x / cam.z, vy0 = -cam.y / cam.z;
  const vx1 = vx0 + board.clientWidth / cam.z, vy1 = vy0 + board.clientHeight / cam.z;
  if (!sorted) sorted = [...items.values()].sort((a, b) => a.t - b.t);
  for (const it of sorted) {
    if (it.kind !== 'stroke') continue;
    const b = bbox(it);
    if (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1) continue;
    drawStroke(bctx, it);
  }
}
function paintLive() {
  clear(lctx);
  if (gesture?.kind === 'draw' && gesture.stroke.p.length) {
    setCam(lctx);
    drawStroke(lctx, gesture.stroke);
  }
  const d = devicePixelRatio || 1;
  const box = (b, fill) => {
    lctx.setTransform(d, 0, 0, d, 0, 0);
    const x = b.x0 * cam.z + cam.x, y = b.y0 * cam.z + cam.y, w = (b.x1 - b.x0) * cam.z, h = (b.y1 - b.y0) * cam.z;
    if (fill) { lctx.fillStyle = fill; lctx.fillRect(x, y, w, h); }
    lctx.strokeStyle = palette.accent;
    lctx.lineWidth = 1.5;
    lctx.setLineDash([6, 4]);
    lctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, Math.round(w) + 1, Math.round(h) + 1);
    lctx.setLineDash([]);
  };
  if (gesture?.kind === 'marquee') box(gesture.rect, palette.accentSoft);
  const sb = selBounds();
  const bar = $('#selbar');
  bar.hidden = !sb || gesture?.kind === 'move' || gesture?.kind === 'marquee';
  if (sb) {
    const pad = 6 / cam.z;
    box({ x0: sb.x0 - pad, y0: sb.y0 - pad, x1: sb.x1 + pad, y1: sb.y1 + pad });
    if (!bar.hidden) {
      const top = sb.y0 * cam.z + cam.y - 14;
      bar.style.left = Math.min(Math.max((sb.x0 + sb.x1) / 2 * cam.z + cam.x, 110), innerWidth - 110) + 'px';
      bar.style.top = Math.max(top, 110) + 'px';
      $('#sel-count').textContent = selection.size === 1 ? '1 item' : `${selection.size} items`;
    }
  }
}
function paintView() {
  textsEl.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  let g = 24 * cam.z;
  while (g < 10) g *= 4;
  board.style.backgroundSize = `${g}px ${g}px`;
  board.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  $('#zoom').textContent = Math.round(cam.z * 100) + '%';
}

let raf = 0, needBase = false, needLive = false;
function schedule(baseToo) {
  needLive = true;
  if (baseToo) needBase = true;
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0;
    if (needBase) { paintBase(); paintView(); }
    if (needLive) paintLive();
    needBase = needLive = false;
  });
}

let camSaveTimer;
function camChanged() {
  schedule(true);
  clearTimeout(camSaveTimer);
  camSaveTimer = setTimeout(() => store.set('sl8:cam:' + noteId, cam), 400);
}
function zoomAt(sx, sy, factor) {
  const z = Math.min(8, Math.max(0.1, cam.z * factor));
  const wx = (sx - cam.x) / cam.z, wy = (sy - cam.y) / cam.z;
  cam = { x: sx - wx * z, y: sy - wy * z, z };
  camChanged();
}

function resize() {
  const d = devicePixelRatio || 1, w = board.clientWidth, h = board.clientHeight;
  for (const c of [base, live]) {
    c.width = Math.round(w * d); c.height = Math.round(h * d);
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }
  schedule(true);
}

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  for (const c of COLORS) palette[c] = cs.getPropertyValue('--ink-' + c).trim();
  palette.hlAlpha = parseFloat(cs.getPropertyValue('--hl-alpha')) || 0.38;
  palette.accent = cs.getPropertyValue('--accent').trim();
  palette.accentSoft = `color-mix(in srgb, ${palette.accent} 10%, transparent)`;
}

/* ---------- items, undo, saving ---------- */
const textEls = new Map();
let undoStack = [], redoStack = [];

function apply(id, item, save = true) {
  if (item) items.set(id, item); else { items.delete(id); selection.delete(id); }
  sorted = null;
  if (item?.kind === 'text') renderText(item);
  else if (!item && textEls.has(id)) { textEls.get(id).remove(); textEls.delete(id); }
  if (save) queue(id, item);
  updateHint();
}
function commit(changes) {
  if (!changes.length) return;
  for (const c of changes) apply(c.id, c.after);
  undoStack.push(changes);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  updateUndo();
}
function undo() {
  const ch = undoStack.pop();
  if (!ch) return;
  document.activeElement?.blur?.();
  for (const c of [...ch].reverse()) apply(c.id, c.before);
  redoStack.push(ch);
  updateUndo();
  schedule(true);
}
function redo() {
  const ch = redoStack.pop();
  if (!ch) return;
  for (const c of ch) apply(c.id, c.after);
  undoStack.push(ch);
  updateUndo();
  schedule(true);
}
function updateUndo() {
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
}

const pending = new Map(); // id -> item, or null for a delete
const pendingKey = 'sl8:pending:' + noteId;
let inflight = null, retryDelay = 0, saveTimer = 0, stopped = false, leaving = false;

function setStatus(text, state = '') {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}
function queue(id, item) {
  pending.set(id, item);
  store.set(pendingKey, [...pending]); // survives a crash or closed tab
  setStatus('Saving…');
  scheduleSave(700);
}
function scheduleSave(ms) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(), ms);
}
function flush(keepalive = false) {
  if (inflight || stopped || !pending.size) return inflight || Promise.resolve();
  inflight = send(keepalive).finally(() => {
    inflight = null;
    if (pending.size && !retryDelay && !stopped) scheduleSave(50);
  });
  return inflight;
}
async function send(keepalive) {
  const batch = [...pending].slice(0, BATCH);
  try {
    await api(`/api/notes/${noteId}/ops`, {
      method: 'POST', keepalive,
      body: { ops: batch.map(([id, it]) => (it ? { put: it } : { del: id })) },
    });
    for (const [id, it] of batch) if (pending.get(id) === it) pending.delete(id);
    store.set(pendingKey, pending.size ? [...pending] : null);
    retryDelay = 0;
    setStatus(pending.size ? 'Saving…' : 'Saved');
  } catch (e) {
    if (e.status === 401) {
      stopped = true;
      setStatus('Logged out', 'error');
      toast('You were logged out. Log in again and reopen this canvas; your unsaved changes stay on this device.');
    } else if (e.status === 404) {
      stopped = true;
      setStatus('Canvas deleted', 'error');
    } else if (e.status >= 400 && e.status < 500) {
      for (const [id] of batch) pending.delete(id); // retrying cannot fix a rejected change
      store.set(pendingKey, pending.size ? [...pending] : null);
      setStatus('Some changes not saved', 'error');
      toast(e.message);
    } else {
      retryDelay = Math.min((retryDelay || 1000) * 2, 30000);
      setStatus('Offline, retrying', 'error');
      scheduleSave(retryDelay);
    }
  }
}
addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush(true));
addEventListener('beforeunload', (e) => { if (pending.size && !stopped && !leaving) e.preventDefault(); });
// finish saving before going back; anything still unsent stays on this device and is sent next time
$('#back').addEventListener('click', async (e) => {
  if (!pending.size || stopped) return;
  e.preventDefault();
  clearTimeout(saveTimer);
  for (let i = 0; i < 30 && pending.size && !stopped; i++) {
    await flush();
    if (retryDelay) break;
  }
  leaving = true;
  location.href = '/canvases';
});

/* ---------- text boxes ---------- */
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}
function renderText(it) {
  let el = textEls.get(it.id);
  if (!el) el = makeTextEl(it.id);
  el.style.left = it.x + 'px';
  el.style.top = it.y + 'px';
  el.style.width = it.w + 'px';
  el.style.setProperty('--fs', it.s + 'px');
  el.style.setProperty('--c', `var(--ink-${it.c})`);
  const ta = el.querySelector('textarea');
  if (ta.value !== it.text && document.activeElement !== ta) ta.value = it.text;
  autosize(ta);
}
function makeTextEl(id) {
  const el = document.createElement('div');
  el.className = 'tb';
  el.innerHTML = '<div class="tb-bar"><button type="button" class="tb-move" aria-label="Drag to move">Move</button><button type="button" class="tb-del" aria-label="Delete text box">Delete</button></div><textarea rows="1" aria-label="Text"></textarea>';
  const ta = el.querySelector('textarea');
  let before = null; // the item as it was when editing started; null for a brand-new box

  ta.addEventListener('focus', () => {
    before = el._isNew ? null : items.get(id);
  });
  ta.addEventListener('input', () => {
    const cur = items.get(id);
    if (!cur) return;
    apply(id, { ...cur, text: ta.value });
    el._sent = true;
    autosize(ta);
  });
  ta.addEventListener('blur', () => {
    const cur = items.get(id);
    if (!cur || el._gone) return;
    el._isNew = false;
    if (!cur.text.trim()) {
      if (before) commit([{ id, before, after: null }]);
      else apply(id, null, !!el._sent);
    } else if (!before || before.text !== cur.text) {
      undoStack.push([{ id, before, after: cur }]);
      redoStack = [];
      updateUndo();
    }
  });
  let resizeTimer;
  new ResizeObserver(() => {
    if (!ta.style.width) return; // only react to the user's drag handle
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const cur = items.get(id);
      const w = Math.round(ta.offsetWidth);
      ta.style.width = '';
      if (cur && Math.abs(w - cur.w) > 2) {
        commit([{ id, before: el._isNew ? null : cur, after: { ...cur, w } }]);
        el._sent = true;
      }
    }, 300);
  }).observe(ta);

  // keep the textarea focused while pressing its buttons
  el.querySelector('.tb-bar').addEventListener('pointerdown', (e) => e.preventDefault());
  el.querySelector('.tb-del').addEventListener('click', () => {
    const cur = items.get(id);
    el._gone = true;
    if (!el._isNew) commit([{ id, before: before || cur, after: null }]);
    else apply(id, null, !!el._sent);
  });
  const mv = el.querySelector('.tb-move');
  mv.addEventListener('pointerdown', (e) => {
    const start = items.get(id);
    if (!start) return;
    mv.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => {
      const it = { ...start, x: Math.round(start.x + (ev.clientX - sx) / cam.z), y: Math.round(start.y + (ev.clientY - sy) / cam.z) };
      items.set(id, it);
      renderText(it);
    };
    const up = () => {
      mv.removeEventListener('pointermove', move);
      mv.removeEventListener('pointerup', up);
      mv.removeEventListener('pointercancel', up);
      const end = items.get(id);
      if (end && (end.x !== start.x || end.y !== start.y)) {
        items.set(id, start);
        commit([{ id, before: el._isNew ? null : start, after: end }]);
        el._isNew = false;
        el._sent = true;
        before = end;
      }
    };
    mv.addEventListener('pointermove', move);
    mv.addEventListener('pointerup', up);
    mv.addEventListener('pointercancel', up);
  });

  textsEl.append(el);
  textEls.set(id, el);
  return el;
}
function newText(wx, wy) {
  const s = SIZES.text[tool.size.text];
  const it = { id: crypto.randomUUID(), kind: 'text', t: Date.now(), x: Math.round(wx), y: Math.round(wy - s * 0.8), w: 320, s, c: tool.color.text, text: '' };
  items.set(it.id, it);
  const el = makeTextEl(it.id);
  el._isNew = true;
  renderText(it);
  el.querySelector('textarea').focus();
  $('#hint').hidden = true;
}

/* ---------- selection ---------- */
function itemRect(it) {
  if (it.kind === 'stroke') return bbox(it);
  const el = textEls.get(it.id);
  return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + (el ? el.offsetHeight : it.s * 1.6) };
}
function selBounds() {
  let b = null;
  for (const id of selection) {
    const it = items.get(id);
    if (!it) continue;
    const r = itemRect(it);
    b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : { ...r };
  }
  return b;
}
function hitItem(x, y) {
  const r = 6 / cam.z;
  if (!sorted) sorted = [...items.values()].sort((a, b) => a.t - b.t);
  for (let i = sorted.length - 1; i >= 0; i--) { // text boxes sit above ink, so they win
    const it = sorted[i];
    if (it.kind !== 'text') continue;
    const b = itemRect(it);
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return it;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const it = sorted[i];
    if (it.kind !== 'stroke') continue;
    const b = bbox(it);
    if (x >= b.x0 - r && x <= b.x1 + r && y >= b.y0 - r && y <= b.y1 + r && hitStroke(it, x, y, r)) return it;
  }
  return null;
}
function setSelection(ids) {
  selection.clear();
  for (const id of ids) if (items.has(id)) selection.add(id);
  for (const [id, el] of textEls) el.classList.toggle('selected', selection.has(id));
  schedule(false);
}
function inRect(it, r) {
  if (it.kind === 'text') {
    const b = itemRect(it);
    return b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0;
  }
  const p = it.p;
  for (let i = 0; i < p.length; i += 3) if (p[i] >= r.x0 && p[i] <= r.x1 && p[i + 1] >= r.y0 && p[i + 1] <= r.y1) return true;
  return false;
}
function moved(it, dx, dy) {
  if (it.kind === 'text') return { ...it, x: Math.round(it.x + dx), y: Math.round(it.y + dy) };
  const p = it.p.slice();
  for (let i = 0; i < p.length; i += 3) {
    p[i] = Math.round((p[i] + dx) * 10) / 10;
    p[i + 1] = Math.round((p[i + 1] + dy) * 10) / 10;
  }
  return { ...it, p };
}
function cancelMove(g) {
  for (const [id, it] of g.orig) { items.set(id, it); if (it.kind === 'text') renderText(it); }
  sorted = null;
  schedule(true);
}
function deleteSelection() {
  const ch = [...selection].map((id) => ({ id, before: items.get(id), after: null })).filter((c) => c.before);
  setSelection([]);
  commit(ch);
  schedule(true);
}
function editText(id) {
  const ta = textEls.get(id)?.querySelector('textarea');
  if (!ta) return;
  setSelection([]);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
// Pan so an item is in view and briefly highlight it (used by AI sources and #item-<id> links).
function focusItem(id) {
  const it = items.get(id);
  if (!it) return false;
  const b = itemRect(it), panel = !$('#ai').hidden;
  const w = board.clientWidth - (panel && innerWidth > 640 ? 424 : 0);
  const cy = panel && innerWidth <= 640 ? innerHeight * 0.16 : board.clientHeight * 0.4;
  cam = { ...cam, x: w / 2 - ((b.x0 + b.x1) / 2) * cam.z, y: cy - ((b.y0 + b.y1) / 2) * cam.z };
  camChanged();
  const el = textEls.get(id);
  if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  else setSelection([id]);
  return true;
}
let lastTap = null;

/* ---------- pointer input ---------- */
const pointers = new Map();
let gesture = null; // draw | erase | pan | pinch | text | idle
const toWorld = (x, y) => [(x - cam.x) / cam.z, (y - cam.y) / cam.z];
const touches = () => [...pointers.values()].filter((p) => p.type === 'touch');

function startPinch() {
  const [a, b] = touches();
  gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cam0: { ...cam } };
  schedule(false);
}

let lastPen = 0; // time of the last pen event, hovering included
function notePen() {
  lastPen = Date.now();
  if (!penSeen) { penSeen = true; store.set('sl8:penSeen', true); updateFinger(); }
}
// null = automatic: fingers draw until a pen is used on this device, then they move the page
let fingerChoice = store.get('sl8:fingerDraws');
const fingerDraws = () => fingerChoice ?? !penSeen;
function updateFinger() {
  $('#finger').setAttribute('aria-pressed', String(fingerDraws()));
}
$('#finger').onclick = () => {
  fingerChoice = !fingerDraws();
  store.set('sl8:fingerDraws', fingerChoice);
  updateFinger();
  toast(fingerChoice ? 'Your finger draws. Use two fingers to move the page.' : 'Your finger moves the page. Draw with your pen.');
};
// palm rejection: the hand resting on the screen is ignored while the pen is down or near it
const penBusy = () => Date.now() - lastPen < 800 || [...pointers.values()].some((p) => p.type === 'pen');

function onDown(e) {
  const isPen = e.pointerType === 'pen';
  if (e.pointerType === 'touch' && penSeen && penBusy()) return;
  if (isPen) {
    notePen();
    if (gesture) { // the pen beats whatever a touch started, e.g. a palm that landed first
      if (gesture.kind === 'erase') endErase(gesture);
      if (gesture.kind === 'move') cancelMove(gesture);
      gesture = null;
      pointers.clear();
      document.body.classList.remove('panning');
      schedule(false);
    }
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  live.setPointerCapture(e.pointerId);
  const wasEditing = document.activeElement?.tagName === 'TEXTAREA';
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();

  if (e.pointerType === 'touch' && touches().length >= 2) {
    if (gesture?.kind === 'pinch' || gesture?.kind === 'idle') return;
    if (gesture?.kind === 'erase') endErase(gesture);
    if (gesture?.kind === 'move') cancelMove(gesture);
    startPinch();
    return;
  }
  if (gesture) return; // another pointer is already busy

  const fingerPans = e.pointerType === 'touch' && !fingerDraws();
  if (spaceDown || tool.name === 'hand' || e.button === 1 || fingerPans) {
    gesture = { kind: 'pan', id: e.pointerId, lx: e.clientX, ly: e.clientY };
    document.body.classList.add('panning');
    return;
  }
  if (e.button === 2) return;
  const penEraser = e.pointerType === 'pen' && (e.buttons & 32 || e.buttons & 2);
  if (penEraser || tool.name === 'eraser') {
    gesture = { kind: 'erase', id: e.pointerId, removed: [] };
    eraseAt(e.clientX, e.clientY);
    return;
  }
  if (tool.name === 'text') {
    gesture = { kind: 'text', id: e.pointerId, sx: e.clientX, sy: e.clientY, wasEditing };
    return;
  }
  if (tool.name === 'select') {
    const [x, y] = toWorld(e.clientX, e.clientY);
    const sb = selBounds(), pad = 8 / cam.z;
    const insideSel = sb && x >= sb.x0 - pad && x <= sb.x1 + pad && y >= sb.y0 - pad && y <= sb.y1 + pad;
    if (!insideSel) {
      const hit = hitItem(x, y);
      if (!hit) {
        const keep = e.shiftKey ? [...selection] : [];
        if (!e.shiftKey) setSelection([]);
        gesture = { kind: 'marquee', id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: x, y0: y, rect: { x0: x, y0: y, x1: x, y1: y }, keep, wasEditing };
        return;
      }
      setSelection(e.shiftKey ? [...selection, hit.id] : [hit.id]);
    }
    gesture = { kind: 'move', id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: x, y0: y, orig: new Map([...selection].map((id) => [id, items.get(id)])) };
    return;
  }
  const hl = tool.name === 'hl';
  const pressure = e.pointerType === 'pen' && !hl;
  gesture = {
    kind: 'draw', id: e.pointerId,
    stroke: { id: crypto.randomUUID(), kind: 'stroke', t: Date.now(), c: tool.color[tool.name], w: SIZES[tool.name][tool.size[tool.name]], hl, pr: pressure, p: [] },
    lastPr: e.pressure || 0.5,
  };
  addPoint(e);
}

function addPoint(e) {
  const g = gesture, p = g.stroke.p;
  const [x, y] = toWorld(e.clientX, e.clientY);
  if (p.length && Math.hypot(x - p[p.length - 3], y - p[p.length - 2]) < 0.6 / cam.z) return;
  let pr = 0.5;
  if (g.stroke.pr) {
    pr = g.lastPr * 0.5 + Math.max(0.05, e.pressure || 0) * 0.5; // smooth pressure jitter
    g.lastPr = pr;
  }
  p.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(pr * 100) / 100);
}

function onMove(e) {
  const ptr = pointers.get(e.pointerId);
  if (!ptr) return;
  ptr.x = e.clientX; ptr.y = e.clientY;
  if (!gesture) return;

  if (gesture.kind === 'pinch') {
    const t = touches();
    if (t.length < 2) return;
    const [a, b] = t;
    const { cam0, d0, mx, my } = gesture;
    const z = Math.min(8, Math.max(0.1, cam0.z * Math.hypot(a.x - b.x, a.y - b.y) / d0));
    const wx = (mx - cam0.x) / cam0.z, wy = (my - cam0.y) / cam0.z;
    const nx = (a.x + b.x) / 2, ny = (a.y + b.y) / 2;
    cam = { x: nx - wx * z, y: ny - wy * z, z };
    camChanged();
    return;
  }
  if (gesture.id !== e.pointerId) return;
  if (gesture.kind === 'pan') {
    cam = { ...cam, x: cam.x + e.clientX - gesture.lx, y: cam.y + e.clientY - gesture.ly };
    gesture.lx = e.clientX; gesture.ly = e.clientY;
    camChanged();
  } else if (gesture.kind === 'draw') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of evs.length ? evs : [e]) addPoint(ce);
    schedule(false);
  } else if (gesture.kind === 'erase') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of evs.length ? evs : [e]) eraseAt(ce.clientX, ce.clientY);
  } else if (gesture.kind === 'move') {
    const [x, y] = toWorld(e.clientX, e.clientY);
    const dx = x - gesture.x0, dy = y - gesture.y0;
    for (const [id, it] of gesture.orig) {
      const m = moved(it, dx, dy);
      items.set(id, m);
      if (m.kind === 'text') renderText(m);
    }
    sorted = null;
    schedule(true);
  } else if (gesture.kind === 'marquee') {
    const [x, y] = toWorld(e.clientX, e.clientY), { x0, y0 } = gesture;
    gesture.rect = { x0: Math.min(x, x0), y0: Math.min(y, y0), x1: Math.max(x, x0), y1: Math.max(y, y0) };
    schedule(false);
  }
}

function onUp(e) {
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.kind === 'pinch') {
    if (!pointers.size) gesture = null;
    else gesture = { kind: 'idle' }; // wait for every finger to lift
    return;
  }
  if (g.kind === 'idle') { if (!pointers.size) gesture = null; return; }
  if (g.id !== e.pointerId) return;
  gesture = null;
  document.body.classList.remove('panning');

  if (g.kind === 'draw' && g.stroke.p.length) {
    commit([{ id: g.stroke.id, before: null, after: g.stroke }]);
    setCam(bctx);
    drawStroke(bctx, g.stroke); // newest stroke is on top, so paint it straight onto the base layer
    schedule(false);
  } else if (g.kind === 'erase') {
    endErase(g);
  } else if (g.kind === 'text' && !g.wasEditing && e.type === 'pointerup' && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 8) {
    newText(...toWorld(e.clientX, e.clientY));
  } else if (g.kind === 'move' || g.kind === 'marquee') {
    const tap = e.type === 'pointerup' && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 6;
    if (g.kind === 'move') {
      if (tap) cancelMove(g);
      else commit([...g.orig].map(([id, before]) => { const after = items.get(id); items.set(id, before); return { id, before, after }; }));
    } else if (!tap) {
      setSelection([...g.keep, ...[...items.values()].filter((it) => inRect(it, g.rect)).map((it) => it.id)]);
    }
    // double-tap: edit the text box under the finger, or start a new one on empty space
    const now = Date.now();
    const dbl = tap && lastTap && now - lastTap.t < 450 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
    lastTap = tap && !dbl && !g.wasEditing ? { t: now, x: e.clientX, y: e.clientY } : null;
    if (dbl) {
      const [x, y] = toWorld(e.clientX, e.clientY);
      const hit = hitItem(x, y);
      if (hit?.kind === 'text') editText(hit.id);
      else if (!g.wasEditing) { setSelection([]); newText(x, y); }
    }
    schedule(true);
  }
}

function endErase(g) {
  if (!g.removed.length) return;
  undoStack.push(g.removed.map((it) => ({ id: it.id, before: it, after: null })));
  redoStack = [];
  updateUndo();
}
function hitStroke(s, x, y, r) {
  const p = s.p, half = (pr) => (s.pr ? s.w * pf(pr) : s.w) / 2;
  if (p.length === 3) return Math.hypot(x - p[0], y - p[1]) <= r + half(p[2]);
  for (let i = 0; i < p.length - 3; i += 3) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 3], by = p[i + 4];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= r + half(p[i + 2])) return true;
  }
  return false;
}
function eraseAt(sx, sy) {
  const [x, y] = toWorld(sx, sy), r = ERASER_PX / cam.z;
  let hit = false;
  for (const s of items.values()) {
    if (s.kind !== 'stroke') continue;
    const b = bbox(s);
    if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) continue;
    if (hitStroke(s, x, y, r)) {
      gesture.removed.push(s);
      apply(s.id, null);
      hit = true;
    }
  }
  if (hit) schedule(true);
}

live.addEventListener('pointerdown', onDown);
live.addEventListener('pointermove', onMove);
live.addEventListener('pointerup', onUp);
live.addEventListener('pointercancel', onUp);
live.addEventListener('contextmenu', (e) => e.preventDefault());
for (const type of ['pointerover', 'pointermove']) {
  board.addEventListener(type, (e) => e.pointerType === 'pen' && notePen());
}
board.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * 0.01));
  else { cam = { ...cam, x: cam.x - e.deltaX * k, y: cam.y - e.deltaY * k }; camChanged(); }
}, { passive: false });

/* ---------- toolbar ---------- */
function setTool(name) {
  tool.name = name;
  store.set('sl8:tool', name);
  if (name !== 'select' && selection.size) setSelection([]);
  document.body.className = 'tool-' + name;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === name));
  renderOptions();
}
function renderOptions() {
  const t = tool.name, opts = $('#options');
  const touchScreen = matchMedia('(any-pointer: coarse)').matches;
  const styled = !!SIZES[t];
  opts.hidden = !styled && !(touchScreen && t === 'eraser');
  for (const id of ['#swatches', '#sep-sizes', '#sizes']) $(id).hidden = !styled;
  $('#finger').hidden = $('#sep-finger').hidden = !touchScreen || t === 'text';
  $('#sep-finger').hidden ||= !styled;
  updateFinger();
  if (!styled) return;
  $('#swatches').replaceChildren(...COLORS.filter((c) => (t === 'hl' ? c !== 'ink' : c !== 'yellow')).map((c) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.setAttribute('aria-label', c === 'ink' ? 'Default ink' : c);
    b.setAttribute('aria-pressed', String(tool.color[t] === c));
    b.innerHTML = `<span style="--c: var(--ink-${c})"></span>`;
    b.onclick = () => { tool.color[t] = c; store.set('sl8:color', tool.color); renderOptions(); };
    return b;
  }));
  $('#sizes').replaceChildren(...SIZES[t].map((_, i) => {
    const b = document.createElement('button');
    b.className = 'size';
    b.setAttribute('aria-label', ['Fine', 'Medium', 'Bold'][i]);
    b.setAttribute('aria-pressed', String(tool.size[t] === i));
    const d = [5, 9, 14][i];
    b.innerHTML = `<span style="width:${d}px;height:${d}px"></span>`;
    b.onclick = () => { tool.size[t] = i; store.set('sl8:size', tool.size); renderOptions(); };
    return b;
  }));
}
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#zoom').onclick = () => zoomAt(board.clientWidth / 2, board.clientHeight / 2, 1 / cam.z);

addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'a' && !typing && tool.name === 'select') { e.preventDefault(); setSelection([...items.keys()]); return; }
  if (e.key === 'Escape') { closeMenu(); if (!typing) setSelection([]); return; }
  if (typing || mod || e.altKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === ' ') { spaceDown = true; document.body.classList.add('panning'); e.preventDefault(); return; }
  const map = { v: 'select', p: 'pen', h: 'hl', e: 'eraser', t: 'text' };
  if (map[e.key]) setTool(map[e.key]);
  else if (e.key === '0') zoomAt(board.clientWidth / 2, board.clientHeight / 2, 1 / cam.z);
  else if (e.key === '+' || e.key === '=') zoomAt(board.clientWidth / 2, board.clientHeight / 2, 1.25);
  else if (e.key === '-') zoomAt(board.clientWidth / 2, board.clientHeight / 2, 0.8);
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; if (gesture?.kind !== 'pan') document.body.classList.remove('panning'); }
});

/* ---------- title ---------- */
let savedTitle = '';
async function saveTitle() {
  const title = titleEl.value.trim() || 'Untitled';
  titleEl.value = title;
  document.title = title + ' · ThinkSL8';
  if (title === savedTitle) return;
  try {
    await api(`/api/notes/${noteId}`, { method: 'PATCH', body: { title } });
    savedTitle = title;
  } catch (e) {
    toast(e.message);
  }
}
titleEl.addEventListener('change', saveTitle);
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleEl.blur(); });

function updateHint() {
  $('#hint').hidden = items.size > 0;
}

/* ---------- options menu: theme and background, saved on this device ---------- */
function closeMenu() {
  $('#menu').hidden = true;
  $('#menu-open').setAttribute('aria-expanded', 'false');
}
$('#menu-open').onclick = () => {
  const open = $('#menu').hidden;
  $('#menu').hidden = !open;
  $('#menu-open').setAttribute('aria-expanded', String(open));
};
addEventListener('pointerdown', (e) => {
  if (!$('#menu').hidden && !e.target.closest?.('#menu, #menu-open')) closeMenu();
}, true);
const setBg = (v) => { board.className = 'bg-' + (v || 'dots'); };
for (const [name, key, fallback, applyFn] of [['m-theme', 'sl8:theme', '', applyTheme], ['m-bg', 'sl8:bg', 'dots', setBg]]) {
  const v = store.get(key) ?? fallback;
  for (const r of document.querySelectorAll(`input[name=${name}]`)) {
    r.checked = r.value === v;
    r.onchange = () => { store.set(key, r.value || null); applyFn(r.value); };
  }
}
setBg(store.get('sl8:bg'));
$('#sel-del').onclick = deleteSelection;

/* ---------- the infinity reveal, played when ThinkSL8 is opened ---------- */
function reveal() {
  let asked = null;
  try { asked = sessionStorage.getItem('sl8:reveal'); sessionStorage.removeItem('sl8:reveal'); } catch {}
  if (!asked) return;
  const mode = store.get('sl8:revealMode') || (store.get('sl8:revealSeen') ? 'short' : 'full');
  store.set('sl8:revealSeen', true);
  if (mode === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const [draw, open] = mode === 'full' ? [1300, 750] : [450, 380];
  const el = document.createElement('div');
  el.className = 'reveal';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--draw', draw + 'ms');
  el.style.setProperty('--open', open + 'ms');
  el.innerHTML = '<svg viewBox="0 0 240 80"><path></path></svg>';
  const path = el.querySelector('path');
  path.setAttribute('d', infinityPath(120, 40, 112));
  document.body.append(el);
  path.style.setProperty('--len', path.getTotalLength());
  const timers = [setTimeout(() => el.classList.add('open'), draw), setTimeout(() => el.remove(), draw + open + 50)];
  const skip = () => { timers.forEach(clearTimeout); el.remove(); };
  el.addEventListener('pointerdown', skip);
  addEventListener('keydown', skip, { once: true });
}

/* ---------- start ---------- */
async function start() {
  if (!noteId) { location.replace('/'); return; }
  reveal();
  readPalette();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readPalette(); schedule(true); });
  new MutationObserver(() => { readPalette(); schedule(true); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setTool(store.get('sl8:tool') || 'select');
  new ResizeObserver(resize).observe(board);
  try {
    const { note, items: list } = await api(`/api/notes/${noteId}`);
    titleEl.value = savedTitle = note.title;
    document.title = note.title + ' · ThinkSL8';
    for (const it of list) apply(it.id, it, false);
    for (const [id, it] of store.get(pendingKey) || []) apply(id, it); // changes that never reached the server
    setStatus(pending.size ? 'Saving…' : 'Saved');
    updateHint();
    schedule(true);
    const target = location.hash.match(/^#item-([\w-]+)$/)?.[1];
    if (target) requestAnimationFrame(() => focusItem(target));
    const msg = aiReturnMessage();
    if (msg) { toast(msg); if (/connected/.test(msg)) window.openAI?.(); }
  } catch (e) {
    if (e.status === 401) return location.replace('/');
    setStatus(e.status === 404 ? 'Not found' : 'Could not load', 'error');
    toast(e.status === 404 ? 'This canvas does not exist or belongs to another account.' : e.message);
  }
}
start();
