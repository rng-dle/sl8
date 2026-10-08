// sl8 editor: infinite canvas with pressure ink, highlighter, eraser and text boxes.
// Items live in world coordinates; the camera maps world -> screen as screen = world * z + (x, y).
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
  name: 'pen',
  color: store.get('sl8:color') || { pen: 'ink', hl: 'yellow', text: 'ink' },
  size: store.get('sl8:size') || { pen: 1, hl: 1, text: 1 },
};
const items = new Map(); // id -> item
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
}

/* ---------- items, undo, saving ---------- */
const textEls = new Map();
let undoStack = [], redoStack = [];

function apply(id, item, save = true) {
  if (item) items.set(id, item); else items.delete(id);
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
      toast('You were logged out. Log in again and reopen this note; your unsaved changes stay on this device.');
    } else if (e.status === 404) {
      stopped = true;
      setStatus('Note deleted', 'error');
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
  location.href = '/';
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
  if (!penSeen) { penSeen = true; store.set('sl8:penSeen', true); }
}
// palm rejection: the hand resting on the screen is ignored while the pen is down or near it
const penBusy = () => Date.now() - lastPen < 800 || [...pointers.values()].some((p) => p.type === 'pen');

function onDown(e) {
  const isPen = e.pointerType === 'pen';
  if (e.pointerType === 'touch' && penSeen && penBusy()) return;
  if (isPen) {
    notePen();
    if (gesture) { // the pen beats whatever a touch started, e.g. a palm that landed first
      if (gesture.kind === 'erase') endErase(gesture);
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
    startPinch();
    return;
  }
  if (gesture) return; // another pointer is already busy

  const fingerPans = e.pointerType === 'touch' && penSeen;
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
  document.body.className = 'tool-' + name;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === name));
  renderOptions();
}
function renderOptions() {
  const t = tool.name, opts = $('#options');
  opts.hidden = !SIZES[t];
  if (opts.hidden) return;
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
  if (typing || mod || e.altKey) return;
  if (e.key === ' ') { spaceDown = true; document.body.classList.add('panning'); e.preventDefault(); return; }
  const map = { p: 'pen', h: 'hl', e: 'eraser', t: 'text' };
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
  document.title = title + ' · sl8';
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

/* ---------- start ---------- */
async function start() {
  if (!noteId) { location.replace('/'); return; }
  readPalette();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readPalette(); schedule(true); });
  new MutationObserver(() => { readPalette(); schedule(true); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setTool('pen');
  new ResizeObserver(resize).observe(board);
  try {
    const { note, items: list } = await api(`/api/notes/${noteId}`);
    titleEl.value = savedTitle = note.title;
    document.title = note.title + ' · sl8';
    for (const it of list) apply(it.id, it, false);
    for (const [id, it] of store.get(pendingKey) || []) apply(id, it); // changes that never reached the server
    setStatus(pending.size ? 'Saving…' : 'Saved');
    updateHint();
    schedule(true);
  } catch (e) {
    if (e.status === 401) return location.replace('/');
    setStatus(e.status === 404 ? 'Not found' : 'Could not load', 'error');
    toast(e.status === 404 ? 'This note does not exist or belongs to another account.' : e.message);
  }
}
start();
