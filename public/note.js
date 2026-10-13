// ThinkSL8 canvas: infinite canvas with pens, highlighter, eraser, text, connections, portals and selection.
// Items live in world coordinates; the camera maps world -> screen as screen = world * z + (x, y).
// ai-panel.js loads after this file and uses its globals (items, selection, commit, focusItem, ...).
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const noteId = params.get('id');
// opened from a share link (?share=<token>): no account needed; `share` is { mode: 'read'|'write', area } once loaded
const shareToken = /^[a-f0-9]{64}$/.test(params.get('share')) ? params.get('share') : null;
const notePath = shareToken ? `/api/shared/${shareToken}` : `/api/notes/${noteId}`;
const canvasKey = noteId || 'share:' + shareToken; // this device's camera and unsent changes are kept under it
let share = null;
// Dot-grid containers, the same maths as the server: level k squares are CELL * 2^k units, aligned to the origin,
// so each splits into four one level down. An item belongs to the square its first point is in.
const CELL = 24;
const cellAt = (k, x, y) => { const s = CELL * 2 ** k; return `${k}/${Math.floor(x / s)}/${Math.floor(y / s)}`; };
const inCells = (cells, x, y) => cells.some((c) => cellAt(+c.split('/')[0], x, y) === c);
const canWrite = (x, y) => !share || (share.mode === 'write' && (share.area === '*' || inCells(share.area, x, y)));
if (shareToken) fileUrl = (id) => `${notePath}/files/${encodeURIComponent(id)}`; // the owner's photos, through the link
const board = $('#board'), base = $('#base'), live = $('#live'), textsEl = $('#texts');
const bctx = base.getContext('2d'), lctx = live.getContext('2d');
const statusEl = $('#status'), titleEl = $('#title');

// Named colours follow the canvas theme (see --ink-* in style.css); anything else is a fixed #rrggbb.
const COLORS = ['ink', 'blue', 'red', 'green', 'yellow', 'orange', 'purple', 'teal', 'pink', 'brown'];
const PRESETS = { pen: ['ink', 'blue', 'red', 'green', 'orange', 'purple', 'teal', 'pink', 'brown'], hl: ['yellow', 'green', 'blue', 'pink', 'orange'] };
PRESETS.text = PRESETS.pen;
const HEX = /^#[0-9a-f]{6}$/i;
const PEN_TYPES = {
  pen: ['Pen', '<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.8a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z"/>'],
  pencil: ['Pencil', '<path d="m15 5 4 4"/><path d="M18 2.5 21.5 6 8 19.5 3 21l1.5-5z"/><path d="m3 21 2-2"/>'],
  marker: ['Marker', '<path d="M9 15 5 19l-2 2h5l2-2"/><path d="m15.5 4.5 4 4L11 17l-4-4z"/><path d="m14 6 4 4"/>'],
  brush: ['Brush', '<path d="M18.4 2.6a2 2 0 0 1 3 3L12 15l-3-3z"/><path d="M9 12c-3 0-5 2-5 5 0 1.5-.5 3-2 4 4 0 9-1 9-6"/>'],
  nib: ['Calligraphy nib', '<path d="m12 19 7-7 3 3-7 7z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="m2 2 7.6 7.6"/><circle cx="11" cy="11" r="2"/>'],
};
const WIDTH = { pen: [1, 30], hl: [6, 60], text: [12, 72] }; // slider range per tool
const BATCH = 40; // must match MAX_OPS on the server
const ERASER_PX = 10;

const saved = store.get('sl8:tools') || {};
const tool = {
  name: 'select',
  type: PEN_TYPES[saved.type] ? saved.type : 'pen',
  color: { pen: 'ink', hl: 'yellow', text: 'ink', ...saved.color },
  width: { pen: 3, hl: 20, text: 20, ...saved.width },
};
let recentColors = (store.get('sl8:recentColors') || []).filter((c) => HEX.test(c));
const saveTools = () => store.set('sl8:tools', { type: tool.type, color: tool.color, width: tool.width });
const colorOf = (c) => palette[c] || (HEX.test(c) ? c : palette.ink);
const cssColor = (c) => (HEX.test(c) ? c : `var(--ink-${COLORS.includes(c) ? c : 'ink'})`);
const items = new Map(); // id -> item
const selection = new Set(); // ids of selected items
let sorted = null; // items ordered by creation time, rebuilt on demand
let cam = store.get('sl8:cam:' + canvasKey) || { x: 48, y: 96, z: 1 };
let palette = {};
let penSeen = !!store.get('sl8:penSeen');
let spaceDown = false;

/* ---------- drawing ---------- */
const pf = (pr) => 0.25 + 1.5 * pr; // pressure -> width factor
// How wide a stroke is at point i (an index into p), as a multiple of s.w, for each pen type.
function widthAt(s, i) {
  const p = s.p, pr = p[i + 2];
  switch (s.pt) {
    case 'brush': { // strong pressure response, tapered ends
      const n = p.length / 3, k = i / 3, taper = Math.min(1, (k + 1) / 6, (n - k) / 6);
      return (s.pr ? 0.15 + 2 * pr : 1.1) * (0.35 + 0.65 * taper);
    }
    case 'nib': { // broad nib held at 45 degrees: thick on one diagonal, hairline on the other
      const j = i >= 3 ? i - 3 : Math.min(i + 3, p.length - 3);
      const a = Math.atan2(p[i + 1] - p[j + 1], p[i] - p[j]);
      return 0.15 + 0.95 * Math.abs(Math.sin(a - Math.PI / 4));
    }
    case 'marker': return 1;
    case 'pencil': return s.pr ? 0.55 + 0.6 * pr : 0.9;
    default: return s.pr ? pf(pr) : 1;
  }
}
const maxWidth = (s) => s.w * (s.pt === 'brush' ? 2.2 : s.pt === 'nib' ? 1.1 : s.pr ? 1.75 : 1);
// pencil grain: a speckled pattern of the ink colour, cached per canvas context and colour
const grains = new Map();
function pencilGrain(ctx, color) {
  const key = (ctx === bctx ? 'b' : 'l') + color;
  let pat = grains.get(key);
  if (!pat) {
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = color;
    for (let i = 0; i < 1100; i++) { g.globalAlpha = 0.15 + Math.random() * 0.85; g.fillRect(Math.random() * 48, Math.random() * 48, 1.3, 1.3); }
    pat = ctx.createPattern(c, 'repeat');
    grains.set(key, pat);
  }
  return pat;
}
const bboxes = new WeakMap();
function bbox(s) {
  let b = bboxes.get(s);
  if (!b) {
    const p = s.p, pad = maxWidth(s) / 2;
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
  const color = colorOf(s.c);
  ctx.globalAlpha = s.hl ? palette.hlAlpha : s.pt === 'marker' ? 0.9 : s.pt === 'pencil' ? 0.85 : 1;
  ctx.strokeStyle = ctx.fillStyle = s.pt === 'pencil' ? pencilGrain(ctx, color) : color;
  ctx.lineCap = ctx.lineJoin = 'round';
  const even = s.pt === 'marker' || (!s.pr && s.pt !== 'brush' && s.pt !== 'nib');
  if (p.length === 3) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], (s.w * widthAt(s, 0)) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (even) {
    ctx.lineWidth = s.w * widthAt(s, 0);
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
      ctx.lineWidth = s.w * widthAt(s, i);
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

/* ---------- photos and videos: drawn under the ink, so you can write on them ---------- */
const isMedia = (it) => it?.kind === 'image' || it?.kind === 'video';
const media = new Map(); // file id -> <img> or <video>, loaded when first drawn
let videoFrame = 0;
function mediaEl(it) {
  let el = media.get(it.file);
  if (!el) {
    el = document.createElement(it.kind === 'video' ? 'video' : 'img');
    if (it.kind === 'video') {
      Object.assign(el, { preload: 'metadata', playsInline: true });
      el.onloadedmetadata = () => { el.currentTime = 0.001; }; // fetch the first frame to show
      el.onseeked = el.onpause = el.onended = () => schedule(true);
      el.onplay = () => { if (!videoFrame) videoFrame = requestAnimationFrame(videoFrames); };
    } else el.onload = () => schedule(true);
    el.src = fileUrl(it.file);
    media.set(it.file, el);
  }
  return el;
}
function videoFrames() { // keep painting while any video plays
  videoFrame = [...media.values()].some((v) => v.tagName === 'VIDEO' && !v.paused) ? requestAnimationFrame(videoFrames) : 0;
  schedule(true);
}
function drawMedia(ctx, it) {
  const el = mediaEl(it), ready = it.kind === 'video' ? el.readyState >= 2 : el.complete && el.naturalWidth;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(it.x, it.y, it.w, it.h, Math.min(10, it.w / 8, it.h / 8));
  ctx.clip();
  if (ready) ctx.drawImage(el, it.x, it.y, it.w, it.h);
  else { ctx.fillStyle = 'rgba(127,127,127,.18)'; ctx.fill(); }
  ctx.restore();
  if (it.kind === 'video' && el.paused) { // a play badge
    const r = Math.max(14, Math.min(it.w, it.h) * 0.11), cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(cx - r * 0.32, cy - r * 0.5); ctx.lineTo(cx + r * 0.55, cy); ctx.lineTo(cx - r * 0.32, cy + r * 0.5); ctx.fill();
  }
}
function toggleVideo(it) {
  const el = mediaEl(it);
  if (el.paused) el.play().catch(() => toast("This video can't play here."));
  else el.pause();
}

// ponytail: full redraw of visible strokes on every camera move; add tile caching if notes reach tens of thousands of strokes
function paintBase() {
  clear(bctx);
  setCam(bctx);
  const vx0 = -cam.x / cam.z, vy0 = -cam.y / cam.z;
  const vx1 = vx0 + board.clientWidth / cam.z, vy1 = vy0 + board.clientHeight / cam.z;
  if (!sorted) sorted = [...items.values()].sort((a, b) => a.t - b.t);
  for (const it of sorted) {
    if (isMedia(it) && it.x < vx1 && it.x + it.w > vx0 && it.y < vy1 && it.y + it.h > vy0) drawMedia(bctx, it);
  }
  for (const it of sorted) {
    if (it.kind !== 'stroke') continue;
    const b = bbox(it);
    if (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1) continue;
    drawStroke(bctx, it);
  }
  for (const it of sorted) if (it.kind === 'conn') drawConn(bctx, it);
}

/* ---------- connections ---------- */
// Where a line from the centre of rect r toward (tx, ty) leaves r, with a little breathing room.
function edgePoint(r, tx, ty) {
  const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2, pad = 8;
  const hw = (r.x1 - r.x0) / 2 + pad, hh = (r.y1 - r.y0) / 2 + pad, dx = tx - cx, dy = ty - cy;
  const k = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9), 1);
  return [cx + dx * k, cy + dy * k];
}
function connEnds(c) {
  const A = items.get(c.a), B = items.get(c.b);
  if (!A || !B) return null; // one end was erased; the arrow comes back if it does
  const ra = itemRect(A), rb = itemRect(B);
  if (!ra || !rb) return null;
  const a = edgePoint(ra, (rb.x0 + rb.x1) / 2, (rb.y0 + rb.y1) / 2), b = edgePoint(rb, (ra.x0 + ra.x1) / 2, (ra.y0 + ra.y1) / 2);
  return Math.hypot(b[0] - a[0], b[1] - a[1]) < 6 ? null : [a, b];
}
function arrow(ctx, [x1, y1], [x2, y2], color, width) {
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1), L = 10 + width * 2;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - L * Math.cos(ang - 0.4), y2 - L * Math.sin(ang - 0.4));
  ctx.lineTo(x2 - L * Math.cos(ang + 0.4), y2 - L * Math.sin(ang + 0.4));
  ctx.closePath(); ctx.fill();
}
function drawConn(ctx, c, highlight) {
  const e = connEnds(c);
  if (!e) return;
  ctx.globalAlpha = highlight ? 1 : 0.85;
  arrow(ctx, e[0], e[1], highlight ? palette.accent : colorOf(c.c), highlight ? 3 : 2);
  ctx.globalAlpha = 1;
  if (c.label) {
    const mx = (e[0][0] + e[1][0]) / 2, my = (e[0][1] + e[1][1]) / 2;
    ctx.font = `600 14px ${palette.font}`;
    const w = ctx.measureText(c.label).width + 14;
    ctx.fillStyle = palette.paper;
    ctx.beginPath(); ctx.roundRect(mx - w / 2, my - 12, w, 24, 8); ctx.fill();
    ctx.fillStyle = palette.text;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.label, mx, my + 1);
  }
}
function distToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
function paintLive() {
  clear(lctx);
  if (picking || (share?.mode === 'write' && share.area !== '*')) paintCells();
  if (gesture?.kind === 'draw' && gesture.stroke.p.length) {
    setCam(lctx);
    drawStroke(lctx, gesture.stroke);
  }
  if (gesture?.kind === 'connect') {
    setCam(lctx);
    const from = items.get(gesture.from), over = gesture.over && items.get(gesture.over);
    if (from) {
      const target = over ? itemRect(over) : null;
      const to = target ? edgePoint(target, ...edgePoint(itemRect(from), gesture.x, gesture.y)) : [gesture.x, gesture.y];
      lctx.setLineDash([8, 6]);
      arrow(lctx, edgePoint(itemRect(from), ...to), to, palette.accent, 2.5);
      lctx.setLineDash([]);
    }
  }
  for (const id of selection) {
    const it = items.get(id);
    if (it?.kind === 'conn') { setCam(lctx); drawConn(lctx, it, true); }
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
  const one = resizable();
  if (one) { // the corner handle that resizes it
    const [hx, hy] = handleAt(one);
    lctx.setTransform(d, 0, 0, d, 0, 0);
    lctx.fillStyle = palette.accent;
    lctx.beginPath(); lctx.arc(hx, hy, 7, 0, Math.PI * 2); lctx.fill();
  }
  $('#sel-play').hidden = items.get([...selection][0])?.kind !== 'video' || selection.size !== 1;
  if (!$('#sel-play').hidden) $('#sel-play').textContent = mediaEl(items.get([...selection][0])).paused ? 'Play' : 'Pause';
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
const resizable = () => { const it = selection.size === 1 && items.get([...selection][0]); return (isMedia(it) || it?.kind === 'embed') && !gesture?.kind?.match(/move|marquee/) ? it : null; };
const handleAt = (it) => [(it.x + it.w) * cam.z + cam.x + 6, (it.y + it.h) * cam.z + cam.y + 6];
function paintView() {
  textsEl.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  paintBackground();
  $('#zoom').textContent = Math.round(cam.z * 100) + '%';
}

/* ---------- this canvas's look: theme, colours, pattern, image ---------- */
let look = {};
const imageSizes = new Map();
function paintBackground() {
  const pattern = look.pattern || store.get('sl8:bg') || 'dots';
  let g = (look.size || 24) * cam.z;
  while (g < 10) g *= 4;
  const L = [], S = [], P = [], R = [];
  const add = (layer, size, pos, rep = 'repeat') => { L.push(layer); S.push(size); P.push(pos); R.push(rep); };
  const at = `${cam.x}px ${cam.y}px`, cell = `${g}px ${g}px`;
  const rule = 'var(--rule)', faint = 'color-mix(in srgb, var(--rule) 55%, transparent)';
  const line = (dir, color, w = 1) => `linear-gradient(${dir}, ${color} ${w}px, transparent ${w}px)`;
  if (pattern === 'dots') add(`radial-gradient(circle, ${rule} 1.1px, transparent 1.5px)`, cell, at);
  if (pattern === 'grid') { add(line('to bottom', faint), cell, at); add(line('to right', faint), cell, at); }
  if (pattern === 'graph') {
    const major = `${g * 5}px ${g * 5}px`;
    add(line('to bottom', rule, 1.5), major, at); add(line('to right', rule, 1.5), major, at);
    add(line('to bottom', faint), cell, at); add(line('to right', faint), cell, at);
  }
  if (pattern === 'lines') add(line('to bottom', faint), cell, at);
  if (pattern === 'iso') { // triangular dot grid: every other row shifted by half a cell
    const h = g * Math.sqrt(3), size = `${g}px ${h}px`;
    add(`radial-gradient(circle, ${rule} 1.1px, transparent 1.5px)`, size, at);
    add(`radial-gradient(circle, ${rule} 1.1px, transparent 1.5px)`, size, `${cam.x + g / 2}px ${cam.y + h / 2}px`);
  }
  const paper = look.paper || 'var(--paper)';
  if (look.image) {
    if (look.dim) add(`linear-gradient(color-mix(in srgb, ${paper} ${Math.round(look.dim * 100)}%, transparent), color-mix(in srgb, ${paper} ${Math.round(look.dim * 100)}%, transparent))`, 'auto', '0 0', 'no-repeat');
    const url = `url("${fileUrl(look.image)}")`, dims = imageSizes.get(look.image);
    if (look.fit === 'tile') add(url, dims ? `${dims[0] * cam.z}px ${dims[1] * cam.z}px` : 'auto', at);
    else add(url, 'cover', 'center', 'no-repeat');
  }
  board.style.backgroundImage = L.join(', ') || 'none';
  board.style.backgroundSize = S.join(', ');
  board.style.backgroundPosition = P.join(', ');
  board.style.backgroundRepeat = R.join(', ');
  board.style.backgroundColor = look.paper || '';
  board.style.setProperty('--rule', look.rule || 'var(--dot)');
}
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// A custom background colour picks light or dark ink automatically unless a theme is chosen.
function applyLook() {
  applyTheme(look.theme || (look.paper ? (luminance(look.paper) < 0.45 ? 'dark' : 'light') : store.get('sl8:theme')));
  if (look.image && look.fit === 'tile' && !imageSizes.has(look.image)) {
    const img = new Image();
    img.onload = () => { imageSizes.set(look.image, [img.naturalWidth, img.naturalHeight]); schedule(true); };
    img.src = fileUrl(look.image);
  }
  schedule(true);
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
    drawMinimap();
  });
}

let camSaveTimer;
function camChanged() {
  schedule(true);
  clearTimeout(camSaveTimer);
  camSaveTimer = setTimeout(() => store.set('sl8:cam:' + canvasKey, cam), 400);
}
// zoom range (Settings): 1x is 10% to 800%; 2x and 4x (the default) go that much further each way
const clampZ = (z) => { const k = { 1: 1, 2: 2, 4: 4 }[store.get('sl8:zoomRange')] || 4; return Math.min(8 * k, Math.max(0.1 / k, z)); };
function zoomAt(sx, sy, factor) {
  const z = clampZ(cam.z * factor);
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
  palette.paper = look.paper || cs.getPropertyValue('--paper').trim();
  palette.text = cs.getPropertyValue('--text').trim();
  palette.font = cs.getPropertyValue('--font-ui').trim();
  grains.clear();
}

/* ---------- items, undo, saving ---------- */
const textEls = new Map();
let undoStack = [], redoStack = [];

let connCount = 0;
function apply(id, item, save = true) {
  const prev = items.get(id);
  connCount += (item?.kind === 'conn') - (prev?.kind === 'conn');
  if (item) items.set(id, item); else { items.delete(id); selection.delete(id); }
  sorted = null;
  if (item) renderDom(item);
  else if (textEls.has(id)) { ctrls.get(id)?.destroy?.(); ctrls.delete(id); textEls.get(id).remove(); textEls.delete(id); }
  if (save) queue(id, item);
  // arrows hang off other items, so anything but a plain new stroke can move them
  if (item?.kind !== 'stroke' && (connCount || item?.kind === 'conn' || prev?.kind === 'conn' || isMedia(item) || isMedia(prev))) schedule(true);
  updateHint();
}
const renderDom = (it) => (it.kind === 'text' ? renderText(it) : it.kind === 'portal' ? renderPortal(it) : it.kind === 'embed' ? renderEmbed(it) : null);
// arrows attached to any of these items
const connsOf = (ids) => [...items.values()].filter((it) => it.kind === 'conn' && (ids.has(it.a) || ids.has(it.b)));
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
const pendingKey = 'sl8:pending:' + canvasKey;
let inflight = null, retryDelay = 0, saveTimer = 0, stopped = false, leaving = false;

function setStatus(text, state = '') {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}
function queue(id, item) {
  if (share?.mode === 'read') return;
  lastActivity = Date.now();
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
    const res = await api(`${notePath}/ops`, {
      method: 'POST', keepalive,
      body: { ops: batch.map(([id, it]) => (it ? { put: it } : { del: id })) },
    });
    saves++;
    for (const [id, it] of batch) if (pending.get(id) === it) pending.delete(id);
    store.set(pendingKey, pending.size ? [...pending] : null);
    retryDelay = 0;
    setStatus(pending.size ? 'Saving…' : 'Saved');
    if (res.rejected) { // a share link changed something outside its area: put back what's really there
      toast('Only the highlighted squares are shared with you, so that change was undone.');
      resync().catch(() => {});
    }
  } catch (e) {
    if (e.status === 404 && shareToken) {
      stopped = true;
      setStatus('Link turned off', 'error');
      toast('This link was turned off, so changes here are no longer saved.');
    } else if (e.status === 401) {
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

/* ---------- sync: changes from your other devices and from people with a link ---------- */
// Bring in items changed elsewhere. Anything with unsaved local changes, being moved or being typed in stays as it is here.
function merge(list, gone) {
  const busy = (id) => pending.has(id) || gesture?.orig?.has?.(id) || !!textEls.get(id)?.contains(document.activeElement);
  let changed = false;
  for (const it of list) {
    if (busy(it.id)) continue;
    const cur = items.get(it.id);
    if (cur && JSON.stringify(cur) === JSON.stringify(it)) continue; // our own save coming back
    apply(it.id, it, false);
    changed = true;
  }
  for (const id of gone) {
    if (!items.has(id) || busy(id)) continue;
    apply(id, null, false);
    changed = true;
  }
  if (changed) schedule(true);
  return changed;
}
async function resync() {
  const r = await api(notePath);
  since = r.now;
  const ids = new Set(r.items.map((it) => it.id));
  merge(r.items, [...items.keys()].filter((id) => !ids.has(id)));
}
// ponytail: polls every 3 s while visible, slowing down when nothing happens; a Durable Object with WebSockets would make it live
let since = 0, saves = 0, lastActivity = Date.now(), pollTimer = 0;
async function poll() {
  clearTimeout(pollTimer);
  if (stopped || !since || document.visibilityState !== 'visible') return;
  const idle = Date.now() - lastActivity;
  const next = () => { pollTimer = setTimeout(poll, idle < 120e3 ? 3000 : idle < 600e3 ? 10000 : 30000); };
  if (inflight) return next();
  const n = saves;
  try {
    const r = await api(`${notePath}?since=${since}`);
    if (r.reload) await resync();
    else if (n === saves) { // a save that finished meanwhile may be newer than this answer; ask again next time
      if (merge(r.items, r.gone)) lastActivity = Date.now();
      since = r.now;
    }
  } catch (e) {
    if (e.status === 401 || e.status === 404) {
      stopped = true;
      return setStatus(e.status === 401 ? 'Logged out' : shareToken ? 'Link turned off' : 'Canvas deleted', 'error');
    }
  }
  next();
}
addEventListener('visibilitychange', () => document.visibilityState === 'visible' && poll());
addEventListener('beforeunload', (e) => { if (pending.size && !stopped && !leaving) e.preventDefault(); });
// finish saving before going back; anything still unsent stays on this device and is sent next time
$('#back').addEventListener('click', (e) => {
  if (!pending.size || stopped) return;
  e.preventDefault();
  leaveTo('/canvases');
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
  el.style.setProperty('--c', cssColor(it.c));
  const ta = el.querySelector('textarea');
  if (ta.value !== it.text && document.activeElement !== ta) ta.value = it.text;
  autosize(ta);
}
function makeTextEl(id) {
  const el = document.createElement('div');
  el.className = 'tb';
  el.innerHTML = '<div class="tb-bar"><button type="button" class="tb-move" aria-label="Drag to move">Move</button><button type="button" class="tb-list" aria-label="Make a checklist">☐ List</button><button type="button" class="tb-del" aria-label="Delete text box">Delete</button></div><textarea rows="1" aria-label="Text"></textarea>';
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
      const arrows = connsOf(new Set([id]));
      if (before) commit([{ id, before, after: null }, ...arrows.map((c) => ({ id: c.id, before: c, after: null }))]);
      else { apply(id, null, !!el._sent); for (const c of arrows) apply(c.id, null); }
    } else if (!before || before.text !== cur.text) {
      undoStack.push([{ id, before, after: cur }]);
      redoStack = [];
      updateUndo();
    }
  });
  // checklists: lines that start with ☐ or ☑. Tap the box to tick it; Enter continues the list; "[] " or "- [ ] " at the start of a line makes one.
  const BOX = /^(☐|☑) /;
  const edit = (fn) => { fn(); ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const lineAt = (pos) => { const a = ta.value.lastIndexOf('\n', pos - 1) + 1, b = ta.value.indexOf('\n', pos); return [a, b < 0 ? ta.value.length : b]; };
  ta.addEventListener('click', () => {
    if (ta.selectionStart !== ta.selectionEnd) return;
    const pos = ta.selectionStart, [a] = lineAt(pos);
    if (pos - a > 1 || !BOX.test(ta.value.slice(a, a + 2))) return;
    edit(() => { ta.setRangeText(ta.value[a] === '☐' ? '☑' : '☐', a, a + 1, 'preserve'); ta.setSelectionRange(a + 2, a + 2); });
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || ta.selectionStart !== ta.selectionEnd) return;
    const pos = ta.selectionStart, [a, b] = lineAt(pos), line = ta.value.slice(a, b);
    if (!BOX.test(line)) return;
    e.preventDefault();
    if (line.length <= 2) edit(() => { ta.setRangeText('', a, b, 'end'); }); // Enter on an empty item ends the list
    else edit(() => { ta.setRangeText('\n☐ ', pos, pos, 'end'); });
  });
  ta.addEventListener('beforeinput', (e) => { // "[] " typed at the start of a line
    if (e.data !== ' ') return;
    const pos = ta.selectionStart, [a] = lineAt(pos), m = ta.value.slice(a, pos).match(/^(?:[-*] )?\[( |x)?\]$/);
    if (!m) return;
    e.preventDefault();
    edit(() => { ta.setRangeText('☐ ', a, pos, 'end'); });
  });
  el.querySelector('.tb-list').addEventListener('click', () => { // box on every selected line, or take them off if they all have one
    const [a] = lineAt(ta.selectionStart), [, b] = lineAt(ta.selectionEnd), lines = ta.value.slice(a, b).split('\n');
    const all = lines.every((l) => BOX.test(l));
    edit(() => { ta.setRangeText(lines.map((l) => (all ? l.replace(BOX, '') : BOX.test(l) ? l : '☐ ' + l)).join('\n'), a, b, 'end'); });
    ta.focus();
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
    const arrows = connsOf(new Set([id])).map((c) => ({ id: c.id, before: c, after: null }));
    if (!el._isNew) commit([{ id, before: before || cur, after: null }, ...arrows]);
    else { apply(id, null, !!el._sent); commit(arrows); }
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
// Tap a checklist box on the canvas (no need to start editing): find which line was tapped by laying the text out in a hidden copy.
function boxAt(it, x, y) {
  const ta = textEls.get(it.id)?.querySelector('textarea');
  if (!ta || !/(^|\n)[☐☑] /.test(it.text)) return null;
  const cs = getComputedStyle(ta), mirror = document.createElement('div');
  for (const k of ['font', 'letterSpacing', 'lineHeight', 'paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'borderLeftWidth', 'borderTopWidth', 'borderStyle', 'boxSizing', 'wordBreak', 'overflowWrap']) mirror.style[k] = cs[k];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', width: ta.clientWidth + parseFloat(cs.borderLeftWidth) * 2 + 'px', whiteSpace: 'pre-wrap', left: '0', top: '0' });
  const rows = it.text.split('\n').map((l) => { const d = document.createElement('div'); d.textContent = l || '\u200b'; mirror.append(d); return d; });
  textsEl.append(mirror);
  const rel = y - it.y, hit = rows.findIndex((d) => rel >= d.offsetTop && rel < d.offsetTop + d.offsetHeight);
  mirror.remove();
  const line = it.text.split('\n')[hit];
  return hit >= 0 && /^[☐☑] /.test(line) && x - it.x <= parseFloat(cs.paddingLeft) + it.s * 1.6 ? hit : null;
}
function toggleBox(it, row) {
  const lines = it.text.split('\n');
  lines[row] = (lines[row][0] === '☐' ? '☑' : '☐') + lines[row].slice(1);
  commit([{ id: it.id, before: it, after: { ...it, text: lines.join('\n') } }]);
}
let tapStart = null;
board.addEventListener('pointerdown', (e) => { tapStart = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
board.addEventListener('pointerup', (e) => {
  if (!tapStart || tool.name !== 'select' || document.activeElement?.closest?.('.tb') || Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 6 || Date.now() - tapStart.t > 500) return;
  const [x, y] = toWorld(e.clientX, e.clientY), hit = hitItem(x, y), row = hit?.kind === 'text' ? boxAt(hit, x, y) : null;
  if (row !== null) toggleBox(hit, row);
});

/* ---------- minimap ---------- */
const mm = $('#minimap'), mmx = mm.getContext('2d'), mmRects = new Map(); // id -> { it, r }: bounds are only recomputed when an item changes
let mmView = null, mmTimer = 0, mmLast = 0, mmShapePath = null;
const mmOn = () => store.get('sl8:minimap') !== 'off';
function drawMinimap() {
  if (!mmOn() || !items.size || !mm) { mm.hidden = true; return; }
  const now = Date.now();
  if (now - mmLast < 120) { clearTimeout(mmTimer); mmTimer = setTimeout(drawMinimap, 130); return; }
  mmLast = now;
  const rects = [];
  for (const [id, it] of items) {
    let c = mmRects.get(id);
    if (!c || c.it !== it) { c = { it, r: it.kind === 'conn' ? null : itemRect(it) }; mmRects.set(id, c); }
    if (c.r) rects.push(c.r);
  }
  for (const id of mmRects.keys()) if (!items.has(id)) mmRects.delete(id);
  const [vx0, vy0] = toWorld(0, 0), [vx1, vy1] = toWorld(board.clientWidth, board.clientHeight);
  let x0 = vx0, y0 = vy0, x1 = vx1, y1 = vy1;
  for (const r of rects) { x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
  const padX = (x1 - x0) * 0.04 || 1, padY = (y1 - y0) * 0.04 || 1;
  x0 -= padX; y0 -= padY; x1 += padX; y1 += padY;
  const shape = MM_ASPECT[store.get('sl8:mmShape')] ? store.get('sl8:mmShape') : 'rounded', [cw, ch] = mmSize(shape), scale = innerWidth <= 640 ? 0.75 : 1;
  const wantW = Math.round(cw * scale * 2), wantH = Math.round(ch * scale * 2);
  if (mm.width !== wantW || mm.height !== wantH) { mm.width = wantW; mm.height = wantH; mm.style.width = wantW / 2 + 'px'; mm.style.height = wantH / 2 + 'px'; }
  const W = mm.width, H = mm.height, [bl, bt, br, bb] = MM_BOX[shape];
  const ix = W * bl, iy = H * bt, iw = W * (br - bl), ih = H * (bb - bt);
  const k = Math.min(iw / (x1 - x0), ih / (y1 - y0)), ox = ix + (iw - (x1 - x0) * k) / 2, oy = iy + (ih - (y1 - y0) * k) / 2;
  mmView = { x0, y0, k, ox, oy };
  mm.hidden = false;
  const cs = getComputedStyle(document.documentElement), path = mmShapePath = new Path2D(); // drawn 4px in from the edge so the border isn't clipped
  path.addPath(mmPath(shape, W - 8, H - 8), new DOMMatrix().translate(4, 4));
  mmx.clearRect(0, 0, W, H);
  mmx.globalAlpha = store.get('sl8:mmBg') ? 1 : 0.9;
  mmx.fillStyle = store.get('sl8:mmBg') || cs.getPropertyValue('--surface').trim() || '#fff';
  mmx.fill(path);
  mmx.globalAlpha = 1;
  mmx.save(); mmx.clip(path);
  mmx.fillStyle = palette.text; mmx.globalAlpha = 0.45;
  for (const r of rects) mmx.fillRect(ox + (r.x0 - x0) * k, oy + (r.y0 - y0) * k, Math.max(2, (r.x1 - r.x0) * k), Math.max(2, (r.y1 - r.y0) * k));
  mmx.globalAlpha = 1;
  mmx.strokeStyle = palette.accent; mmx.lineWidth = 3; mmx.fillStyle = palette.accentSoft;
  const vx = ox + (vx0 - x0) * k, vy = oy + (vy0 - y0) * k, vw = (vx1 - vx0) * k, vh = (vy1 - vy0) * k;
  mmx.fillRect(vx, vy, vw, vh); mmx.strokeRect(vx, vy, vw, vh);
  mmx.restore();
  mmx.lineWidth = store.get('sl8:mmBorder') ? 5 : 2;
  mmx.strokeStyle = store.get('sl8:mmBorder') || cs.getPropertyValue('--line').trim() || '#ccc';
  mmx.stroke(path);
}
function mmJump(e) {
  if (!mmView) return;
  const r = mm.getBoundingClientRect(), wx = mmView.x0 + ((e.clientX - r.left) / r.width * mm.width - mmView.ox) / mmView.k, wy = mmView.y0 + ((e.clientY - r.top) / r.height * mm.height - mmView.oy) / mmView.k;
  cam = { ...cam, x: board.clientWidth / 2 - wx * cam.z, y: board.clientHeight / 2 - wy * cam.z };
  camChanged();
}
mm.addEventListener('pointerdown', (e) => {
  const r = mm.getBoundingClientRect();
  if (mmShapePath && !mmx.isPointInPath(mmShapePath, (e.clientX - r.left) / r.width * mm.width, (e.clientY - r.top) / r.height * mm.height)) return; // outside the shape
  mm.setPointerCapture(e.pointerId); mmJump(e);
});
mm.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') mmJump(e); });
const mmLabel = () => { $('#minimap-toggle').textContent = mmOn() ? 'Hide minimap' : 'Show minimap'; $('#mm-btn').setAttribute('aria-pressed', String(mmOn())); };
const mmFlip = () => { store.set('sl8:minimap', mmOn() ? 'off' : 'on'); mmLabel(); drawMinimap(); };
$('#minimap-toggle').onclick = () => { closeMenu(); mmFlip(); };
$('#mm-btn').onclick = mmFlip;
addEventListener('storage', () => { mmLabel(); drawMinimap(); });
mmLabel();

const outside = () => toast('Only the highlighted squares are shared with you. Write inside them.');
function newText(wx, wy) {
  if (!canWrite(wx, wy)) return outside();
  const s = tool.width.text;
  const it = { id: crypto.randomUUID(), kind: 'text', t: Date.now(), x: Math.round(wx), y: Math.round(wy - s * 0.8), w: 320, s, c: tool.color.text, text: '' };
  items.set(it.id, it);
  const el = makeTextEl(it.id);
  el._isNew = true;
  renderText(it);
  el.querySelector('textarea').focus();
  $('#hint').hidden = true;
  return it;
}

/* ---------- portals: cards that open another canvas ---------- */
const canvasTitles = new Map(); // id -> title, for every canvas this account has
const PORTAL_W = 240, PORTAL_H = 132;
function renderPortal(it) {
  let el = textEls.get(it.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'portal';
    el.innerHTML = `${eightMark('portal-mark')}<b class="portal-title"></b><button type="button" class="portal-open">Open</button>`;
    el.querySelector('.portal-open').addEventListener('click', () => openPortal(it.id));
    textsEl.append(el);
    textEls.set(it.id, el);
    el.classList.toggle('selected', selection.has(it.id));
  }
  Object.assign(el.style, { left: it.x + 'px', top: it.y + 'px', width: it.w + 'px', height: it.h + 'px' });
  const title = canvasTitles.get(it.target);
  el.classList.toggle('missing', title === undefined);
  el.querySelector('.portal-title').textContent = title ?? 'This canvas was deleted';
  el.querySelector('.portal-open').setAttribute('aria-label', `Open ${title}`);
}
// Leave this canvas, finishing any unsent saves first (anything still unsent stays on this device).
async function leaveTo(href) {
  if (pending.size && !stopped) {
    clearTimeout(saveTimer);
    for (let i = 0; i < 30 && pending.size && !stopped; i++) {
      await flush();
      if (retryDelay) break;
    }
  }
  leaving = true;
  go(href);
}
const trail = () => { try { return JSON.parse(sessionStorage.getItem('sl8:trail')) || []; } catch { return []; } };
const setTrail = (t) => { try { sessionStorage.setItem('sl8:trail', JSON.stringify(t.slice(-20))); } catch {} };
async function openPortal(id) {
  const it = items.get(id);
  if (!it || !canvasTitles.has(it.target)) return toast("That canvas doesn't exist anymore.");
  setTrail([...trail().filter((t) => t.id !== noteId), { id: noteId, title: titleEl.value }]);
  const el = textEls.get(id);
  if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) { // dive into the portal
    const r = el.getBoundingClientRect();
    board.style.transformOrigin = `${r.left + r.width / 2}px ${r.top + r.height / 2}px`;
    board.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(3)', opacity: 0 }], { duration: 320, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
    try { sessionStorage.setItem('sl8:arrive', '1'); } catch {}
  }
  await Promise.all([leaveTo('/note?id=' + encodeURIComponent(it.target)), new Promise((r) => setTimeout(r, 300))]);
}
function addPortal(target) {
  const [x, y] = toWorld(board.clientWidth / 2 - PORTAL_W / 2 * cam.z, board.clientHeight * 0.4);
  const it = { id: crypto.randomUUID(), kind: 'portal', t: Date.now(), x: Math.round(x), y: Math.round(y), w: PORTAL_W, h: PORTAL_H, target };
  commit([{ id: it.id, before: null, after: it }]);
  setTool('select');
  setSelection([it.id]);
}

/* ---------- selection ---------- */
function itemRect(it) {
  if (it.kind === 'stroke') return bbox(it);
  if (it.kind === 'portal' || it.kind === 'embed' || isMedia(it)) return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
  if (it.kind === 'conn') {
    const e = connEnds(it);
    return e && { x0: Math.min(e[0][0], e[1][0]), y0: Math.min(e[0][1], e[1][1]), x1: Math.max(e[0][0], e[1][0]), y1: Math.max(e[0][1], e[1][1]) };
  }
  const el = textEls.get(it.id);
  return { x0: it.x, y0: it.y, x1: it.x + textWidth(it), y1: it.y + (el ? el.offsetHeight : it.s * 1.6) };
}
// The width the words actually take (not the whole box), so arrows and selection hug the text.
let textWidths = new WeakMap(), measure;
function textWidth(it) {
  let w = textWidths.get(it);
  if (w === undefined) {
    measure ||= document.createElement('canvas').getContext('2d');
    measure.font = `400 ${it.s}px ${palette.font || 'sans-serif'}`;
    const longest = Math.max(...String(it.text || '').split('\n').map((l) => measure.measureText(l).width));
    w = Math.min(it.w, Math.max(80, longest + 16)); // textarea padding and border
    textWidths.set(it, w);
  }
  return w;
}
document.fonts?.ready.then(() => { textWidths = new WeakMap(); schedule(true); });
function selBounds() {
  let b = null;
  for (const id of selection) {
    const it = items.get(id);
    if (!it) continue;
    const r = itemRect(it);
    if (!r) continue;
    b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : { ...r };
  }
  return b;
}
function hitItem(x, y) {
  const r = 6 / cam.z;
  if (!sorted) sorted = [...items.values()].sort((a, b) => a.t - b.t);
  for (let i = sorted.length - 1; i >= 0; i--) { // text and portals sit above everything drawn
    const it = sorted[i];
    if (it.kind !== 'text' && it.kind !== 'portal' && it.kind !== 'embed') continue;
    const b = itemRect(it);
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return it;
  }
  for (let i = sorted.length - 1; i >= 0; i--) { // then arrows, then ink
    const it = sorted[i];
    if (it.kind !== 'conn') continue;
    const e = connEnds(it);
    if (e && distToSegment(x, y, e[0], e[1]) <= r + 3) return it;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const it = sorted[i];
    if (it.kind !== 'stroke') continue;
    const b = bbox(it);
    if (x >= b.x0 - r && x <= b.x1 + r && y >= b.y0 - r && y <= b.y1 + r && hitStroke(it, x, y, r)) return it;
  }
  for (let i = sorted.length - 1; i >= 0; i--) { // photos and videos are underneath the ink
    const it = sorted[i];
    if (isMedia(it) && x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
  }
  return null;
}
function setSelection(ids) {
  selection.clear();
  for (const id of ids) if (items.has(id)) selection.add(id);
  for (const [id, el] of textEls) { el.classList.toggle('selected', selection.has(id)); if (!selection.has(id)) el.classList.remove('live'); }
  schedule(false);
}
function inRect(it, r) {
  if (it.kind !== 'stroke') {
    const b = itemRect(it);
    return !!b && b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0;
  }
  const p = it.p;
  for (let i = 0; i < p.length; i += 3) if (p[i] >= r.x0 && p[i] <= r.x1 && p[i + 1] >= r.y0 && p[i + 1] <= r.y1) return true;
  return false;
}
function moved(it, dx, dy) {
  if (it.kind === 'conn') return it; // arrows follow their ends
  if (it.kind !== 'stroke') return { ...it, x: Math.round(it.x + dx), y: Math.round(it.y + dy) };
  const p = it.p.slice();
  for (let i = 0; i < p.length; i += 3) {
    p[i] = Math.round((p[i] + dx) * 10) / 10;
    p[i + 1] = Math.round((p[i + 1] + dy) * 10) / 10;
  }
  return { ...it, p };
}
function cancelMove(g) {
  for (const [id, it] of g.orig) { items.set(id, it); renderDom(it); }
  sorted = null;
  schedule(true);
}
function deleteSelection() {
  const ids = new Set(selection);
  for (const c of connsOf(ids)) ids.add(c.id); // arrows go with what they connect, and come back on undo
  const ch = [...ids].map((id) => ({ id, before: items.get(id), after: null })).filter((c) => c.before);
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

  const fingerPans = e.pointerType === 'touch' && !fingerDraws() && !picking;
  if (spaceDown || (tool.name === 'hand' && !picking) || e.button === 1 || fingerPans) {
    gesture = { kind: 'pan', id: e.pointerId, lx: e.clientX, ly: e.clientY, sx: e.clientX, sy: e.clientY, wasEditing };
    document.body.classList.add('panning');
    return;
  }
  if (e.button === 2) return;
  if (picking) { // choosing squares to share: tap or drag across them; the first square decides add or remove
    picking.level = pickLevel();
    picking.adding = !picking.cells.has(cellAt(picking.level, ...toWorld(e.clientX, e.clientY)));
    gesture = { kind: 'pick', id: e.pointerId };
    pickAt(e.clientX, e.clientY);
    return;
  }
  const penEraser = e.pointerType === 'pen' && (e.buttons & 32 || e.buttons & 2);
  if (penEraser || tool.name === 'eraser') {
    gesture = { kind: 'erase', id: e.pointerId, removed: [], lx: e.clientX, ly: e.clientY, lt: e.timeStamp };
    scribble.start('eraser');
    eraseAt(e.clientX, e.clientY);
    return;
  }
  if (tool.name === 'connect') {
    const [x, y] = toWorld(e.clientX, e.clientY);
    const from = hitItem(x, y);
    if (!from || from.kind === 'conn') return toast('Start on a note, drawing or portal, then drag to another one or into empty space.');
    gesture = { kind: 'connect', id: e.pointerId, from: from.id, x, y, sx: e.clientX, sy: e.clientY };
    return;
  }
  if (tool.name === 'text') {
    gesture = { kind: 'text', id: e.pointerId, sx: e.clientX, sy: e.clientY, wasEditing };
    return;
  }
  if (tool.name === 'select') {
    const one = resizable();
    if (one && Math.hypot(e.clientX - handleAt(one)[0], e.clientY - handleAt(one)[1]) < (e.pointerType === 'mouse' ? 12 : 24)) {
      gesture = { kind: 'resize', id: e.pointerId, orig: one };
      return;
    }
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
  if (!canWrite(...toWorld(e.clientX, e.clientY))) return outside();
  const hl = tool.name === 'hl';
  const pressure = e.pointerType === 'pen' && !hl;
  const stroke = { id: crypto.randomUUID(), kind: 'stroke', t: Date.now(), c: tool.color[tool.name], w: tool.width[tool.name], hl, pr: pressure, p: [] };
  if (!hl && tool.type !== 'pen') stroke.pt = tool.type;
  gesture = { kind: 'draw', id: e.pointerId, stroke, lastPr: e.pressure || 0.5, lx: e.clientX, ly: e.clientY, lt: e.timeStamp };
  scribble.start(hl ? 'hl' : tool.type);
  addPoint(e);
}
// feed the writing sound with how fast the pointer is moving
function sound(g, e) {
  const dt = Math.max(1, e.timeStamp - g.lt);
  scribble.move(Math.hypot(e.clientX - g.lx, e.clientY - g.ly) / dt, e.pressure || 0.5);
  g.lx = e.clientX; g.ly = e.clientY; g.lt = e.timeStamp;
}

function addPoint(e, exact, g = gesture) {
  const p = g.stroke.p;
  let [x, y] = toWorld(e.clientX, e.clientY);
  if (e.pointerType === 'mouse' && p.length && !exact) { // steadies a mouse or trackpad hand: each point goes part way to the cursor
    x = p[p.length - 3] + (x - p[p.length - 3]) * 0.45;
    y = p[p.length - 2] + (y - p[p.length - 2]) * 0.45;
  }
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
    const z = clampZ(cam0.z * Math.hypot(a.x - b.x, a.y - b.y) / d0);
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
    sound(gesture, e);
    schedule(false);
  } else if (gesture.kind === 'erase') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of evs.length ? evs : [e]) eraseAt(ce.clientX, ce.clientY);
    sound(gesture, e);
  } else if (gesture.kind === 'connect') {
    [gesture.x, gesture.y] = toWorld(e.clientX, e.clientY);
    const over = hitItem(gesture.x, gesture.y);
    gesture.over = over && over.kind !== 'conn' && over.id !== gesture.from ? over.id : null;
    schedule(false);
  } else if (gesture.kind === 'move') {
    const [x, y] = toWorld(e.clientX, e.clientY);
    const dx = x - gesture.x0, dy = y - gesture.y0;
    for (const [id, it] of gesture.orig) {
      const m = moved(it, dx, dy);
      items.set(id, m);
      renderDom(m);
    }
    sorted = null;
    schedule(true);
  } else if (gesture.kind === 'resize') { // keeps its shape
    const o = gesture.orig, w = Math.max(24, toWorld(e.clientX, e.clientY)[0] - o.x);
    items.set(o.id, { ...o, w: Math.round(w), h: Math.round((w * o.h) / o.w) });
    renderDom(items.get(o.id));
    schedule(true);
  } else if (gesture.kind === 'pick') {
    pickAt(e.clientX, e.clientY);
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
  scribble.stop();

  if (g.kind === 'draw' && g.stroke.p.length) {
    if (e.pointerType === 'mouse' && e.type === 'pointerup') addPoint(e, true, g); // end where the cursor is
    commit([{ id: g.stroke.id, before: null, after: g.stroke }]);
    setCam(bctx);
    drawStroke(bctx, g.stroke); // newest stroke is on top, so paint it straight onto the base layer
    schedule(false);
  } else if (g.kind === 'erase') {
    endErase(g);
  } else if (g.kind === 'resize') {
    const after = items.get(g.orig.id);
    items.set(g.orig.id, g.orig);
    if (after.w !== g.orig.w) commit([{ id: g.orig.id, before: g.orig, after }]);
    schedule(true);
  } else if (g.kind === 'text' && !g.wasEditing && e.type === 'pointerup' && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 8) {
    newText(...toWorld(e.clientX, e.clientY));
  } else if (g.kind === 'connect') {
    schedule(false);
    if (e.type !== 'pointerup') return;
    const conn = (b) => ({ id: crypto.randomUUID(), kind: 'conn', t: Date.now(), a: g.from, b, c: 'ink' });
    if (g.over) {
      const exists = [...items.values()].some((it) => it.kind === 'conn' && it.a === g.from && it.b === g.over);
      if (!exists) {
        const c = conn(g.over);
        commit([{ id: c.id, before: null, after: c }]);
      }
    } else if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 30) {
      // dragged into empty space: start a new note there, already connected
      const note = newText(g.x, g.y);
      if (note) {
        const c = conn(note.id);
        commit([{ id: c.id, before: null, after: c }]);
      }
    }
  } else if (g.kind === 'move' || g.kind === 'marquee') {
    const tap = e.type === 'pointerup' && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 6;
    if (g.kind === 'move') {
      if (tap) cancelMove(g);
      else commit([...g.orig].map(([id, before]) => { const after = items.get(id); items.set(id, before); return { id, before, after }; }));
    } else if (!tap) {
      setSelection([...g.keep, ...[...items.values()].filter((it) => inRect(it, g.rect)).map((it) => it.id)]);
    }
    doubleTap(e, tap, g.wasEditing);
    schedule(true);
  } else if (g.kind === 'pan' && e.pointerType === 'touch' && tool.name !== 'hand') {
    // fingers move the page once a pen is used, but a finger that didn't move is still a tap:
    // with the text tool it starts a note, and a double-tap works with any tool
    const tap = e.type === 'pointerup' && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 8;
    if (tap && tool.name === 'text' && !g.wasEditing) newText(...toWorld(e.clientX, e.clientY));
    else doubleTap(e, tap, g.wasEditing);
  }
}
// double-tap: edit the text box under the finger, or start a new one on empty space
function doubleTap(e, tap, wasEditing) {
  const now = Date.now();
  const dbl = tap && lastTap && now - lastTap.t < 450 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
  lastTap = tap && !dbl && !wasEditing ? { t: now, x: e.clientX, y: e.clientY } : null;
  if (!dbl) return;
  const [x, y] = toWorld(e.clientX, e.clientY);
  const hit = hitItem(x, y);
  if (hit?.kind === 'text') editText(hit.id);
  else if (hit?.kind === 'portal') openPortal(hit.id);
  else if (hit?.kind === 'embed') textEls.get(hit.id)?.classList.toggle('live');
  else if (hit?.kind === 'conn') editLabel(hit.id);
  else if (hit?.kind === 'video') toggleVideo(hit);
  else if (!wasEditing) { setSelection([]); newText(x, y); }
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
      for (const c of connsOf(new Set([s.id]))) { gesture.removed.push(c); apply(c.id, null); }
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
  if (share?.mode === 'read') name = 'hand'; // a view link only moves around
  else store.set('sl8:tool', name);
  tool.name = name;
  if (name !== 'select' && selection.size) setSelection([]);
  document.body.className = 'tool-' + name;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === name));
  renderOptions();
}
function renderOptions() {
  const t = tool.name, opts = $('#options');
  const touchScreen = matchMedia('(any-pointer: coarse)').matches;
  const styled = t === 'pen' || t === 'hl' || t === 'text';
  const show = (id, on) => ($(id).hidden = !on);
  show('#types', t === 'pen'); show('#sep-types', t === 'pen');
  for (const id of ['#swatches', '#custom-wrap', '#color-type', '#sep-width', '#width']) show(id, styled);
  const sound = t === 'pen' || t === 'hl' || t === 'eraser', finger = touchScreen && sound; // finger drawing only matters for drawing tools
  show('#sound', sound); show('#finger', finger); show('#sep-toggles', styled && (sound || finger));
  opts.hidden = !styled && !sound && !finger;
  updateFinger();
  $('#sound').setAttribute('aria-pressed', String(scribble.on));
  if (!styled) return ringSync();
  if (t === 'pen') {
    $('#types').replaceChildren(...Object.entries(PEN_TYPES).map(([k, [label, icon]]) => {
      const b = document.createElement('button');
      b.className = 'icon-btn';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(tool.type === k));
      b.innerHTML = `<svg viewBox="0 0 24 24">${icon}</svg>`;
      b.onclick = () => { tool.type = k; saveTools(); renderOptions(); };
      return b;
    }));
  }
  const presets = [...PRESETS[t], ...recentColors.filter((c) => !PRESETS[t].includes(c))];
  $('#swatches').replaceChildren(...presets.map((c) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.setAttribute('aria-label', HEX.test(c) ? `Colour ${c}` : c === 'ink' ? 'Default ink' : c);
    b.setAttribute('aria-pressed', String(tool.color[t] === c));
    b.innerHTML = `<span style="--c: ${cssColor(c)}"></span>`;
    b.onclick = () => { tool.color[t] = c; saveTools(); renderOptions(); };
    return b;
  }));
  const current = colorOf(tool.color[t]);
  $('#custom-color').value = HEX.test(current) ? current : '#000000';
  const [lo, hi] = WIDTH[t], w = $('#width');
  w.min = lo; w.max = hi; w.step = t === 'pen' ? 0.5 : 1; w.value = tool.width[t];
  w.setAttribute('aria-label', t === 'text' ? 'Text size' : 'Line width');
  ringSync();
}
// any colour: the native picker gives RGB, HSL and hex on every platform
$('#custom-color').addEventListener('input', (e) => { tool.color[tool.name] = e.target.value; saveTools(); });
$('#custom-color').addEventListener('change', (e) => {
  recentColors = [e.target.value, ...recentColors.filter((c) => c !== e.target.value)].slice(0, 4);
  store.set('sl8:recentColors', recentColors);
  renderOptions();
});

// Type a colour: #rgb, #rrggbb, rgb(r, g, b) or hsl(h, s%, l%) (also "r g b"), shown back in all three forms
function parseColor(text) {
  const t = text.trim().toLowerCase(), hex = (r, g, b) => '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
  let m = t.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) { const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]; return '#' + h; }
  const n = (t.match(/-?\d*\.?\d+/g) || []).map(Number);
  if (/^hsl/.test(t) && n.length === 3) {
    const h = ((n[0] % 360) + 360) % 360, s = Math.max(0, Math.min(100, n[1])) / 100, l = Math.max(0, Math.min(100, n[2])) / 100;
    const k = (x) => (x + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (x) => l - a * Math.max(-1, Math.min(k(x) - 3, 9 - k(x), 1));
    return hex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  if ((/^rgb/.test(t) || /^[\d\s,.]+$/.test(t)) && n.length === 3) return hex(...n);
  return null;
}
function describeColor(h) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2, d = mx - mn;
  let hue = 0;
  if (d) hue = mx === r / 255 ? ((g - b) / 255 / d + 6) % 6 : mx === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return `${h} · rgb(${r}, ${g}, ${b}) · hsl(${Math.round(hue * 60)}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)`;
}
$('#color-type').onclick = () => {
  const open = $('#color-menu').hidden;
  $('#color-menu').hidden = !open;
  if (!open) return;
  $('#color-now').textContent = 'Now: ' + describeColor(colorOf(tool.color[tool.name]));
  $('#color-text').value = '';
  $('#color-text').focus();
};
$('#color-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = parseColor($('#color-text').value);
  if (!c) return toast('Try a colour like #d9661b, rgb(217, 102, 27) or hsl(24, 78%, 48%).');
  tool.color[tool.name] = c; saveTools();
  recentColors = [c, ...recentColors.filter((x) => x !== c)].slice(0, 4);
  store.set('sl8:recentColors', recentColors);
  $('#color-menu').hidden = true;
  renderOptions();
});
addEventListener('pointerdown', (e) => { if (!$('#color-menu').hidden && !e.target.closest?.('#color-menu, #color-type')) $('#color-menu').hidden = true; }, true);
$('#width').addEventListener('input', (e) => { tool.width[tool.name] = Number(e.target.value); saveTools(); });
$('#sound').onclick = () => {
  scribble.on = !scribble.on;
  renderOptions();
  toast(scribble.on ? 'Writing sounds on.' : 'Writing sounds off.');
};
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#zoom').onclick = () => zoomAt(board.clientWidth / 2, board.clientHeight / 2, 1 / cam.z);

/* ---------- ring: one floating button; the same tool buttons fan out in circles around it (Settings > Tools) ---------- */
// Inner ring: the tools, undo and redo. Outer ring: the current tool's options, with the size slider along the bottom.
const ringOn = () => store.get('sl8:toolbar') !== 'bar' && Math.min(innerWidth, innerHeight) >= 360; // small screens keep the bar
const ringOpen = () => $('.dock').classList.contains('open');
const toolK = () => Math.min(1.5, Math.max(0.75, Number(store.get('sl8:toolSize')) || 1)); // Settings > Tools > Size
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let fabAt = store.get('sl8:fab'); // { fx, fy }: fractions of the window, so it stays put through rotation

function ringSync() {
  const t = tool.name, fab = $('#fab');
  fab.innerHTML = t === 'pen' ? `<svg viewBox="0 0 24 24">${PEN_TYPES[tool.type][1]}</svg>` : $(`[data-tool="${t}"] svg`).outerHTML;
  fab.style.setProperty('--fab-c', tool.color[t] ? cssColor(tool.color[t]) : '');
  fab.setAttribute('aria-label', 'Tools: ' + $(`[data-tool="${t}"]`).getAttribute('aria-label'));
  layoutRing();
}

function layoutRing() {
  const dock = $('.dock'), on = ringOn();
  let k = toolK();
  dock.style.setProperty('--k', k);
  if (!on) {
    dock.classList.remove('ring', 'open'); $('#ring-scrim').hidden = true;
    const w = $('nav.bar').getBoundingClientRect().width, room = innerWidth - 24; // a big size still keeps the bar on screen
    if (w > room) dock.style.setProperty('--k', (k * room) / w);
    return;
  }
  if (!dock.classList.contains('ring')) { // switching from the bar: start folded, without animating out of it
    dock.classList.add('ring', 'still');
    requestAnimationFrame(() => requestAnimationFrame(() => dock.classList.remove('still')));
  }
  // mark every item before measuring, so new swatches start folded instead of fading out
  for (const el of dock.querySelectorAll('nav.bar > button, #options button, #options label, #width')) el.classList.add('ring-item');
  const open = ringOpen();
  const shown = (el) => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
  const inner = [...dock.querySelectorAll('nav.bar > button')].filter(shown);
  const outer = [...dock.querySelectorAll('#options button, #options label')].filter(shown);
  const slider = shown($('#width')) ? $('#width') : null;
  // radii at size 1, then scaled by the tool size (Settings > Tools), shrunk if needed so the open ring fits the screen
  const gap = slider ? 1.3 : 0; // radians kept free at the bottom for the slider
  const r1 = Math.max(88, (inner.length * 52) / (2 * Math.PI)), r2 = Math.max(148, (outer.length * 38) / (2 * Math.PI - gap));
  const reach = outer.length || slider ? r2 + 26 : r1 + 30, m = 8;
  if (open) k = Math.min(k, (Math.min(innerWidth, innerHeight) / 2 - m) / reach);
  dock.style.setProperty('--k', k);
  let n = 0;
  const place = (el, x, y) => {
    el.style.setProperty('--x', (open ? x * k : 0) + 'px');
    el.style.setProperty('--y', (open ? y * k : 0) + 'px');
    el.style.setProperty('--d', (open ? n++ * 0.012 : 0) + 's'); // a quick stagger as they fan out
  };
  inner.forEach((el, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / inner.length; place(el, r1 * Math.cos(a), r1 * Math.sin(a)); });
  outer.forEach((el, i) => { const a = -Math.PI / 2 + ((i - (outer.length - 1) / 2) * 38) / r2; place(el, r2 * Math.cos(a), r2 * Math.sin(a)); });
  if (slider) place(slider, 0, r2);
  // open near an edge: the button slides in just far enough for the whole ring to fit
  const x = clamp((fabAt?.fx ?? 1) * innerWidth, 40 * k, innerWidth - 40 * k), y = clamp((fabAt?.fy ?? 1) * innerHeight, 40 * k, innerHeight - 56 * k);
  const fit = (v, size) => (size < 2 * (reach * k + m) ? size / 2 : clamp(v, reach * k + m, size - reach * k - m));
  dock.style.setProperty('--fx', (open ? fit(x, innerWidth) : x) + 'px');
  dock.style.setProperty('--fy', (open ? fit(y, innerHeight) : y) + 'px');
}

function openRing(on) {
  $('.dock').classList.toggle('open', on);
  $('#ring-scrim').hidden = !on;
  $('#fab').setAttribute('aria-expanded', String(on));
  layoutRing();
}

// tap to open; drag to move it anywhere
let fabDrag = null;
$('#fab').addEventListener('pointerdown', (e) => {
  $('#fab').setPointerCapture(e.pointerId);
  fabDrag = { x: e.clientX, y: e.clientY, moved: false };
});
$('#fab').addEventListener('pointermove', (e) => {
  if (!fabDrag || ringOpen()) return;
  if (!fabDrag.moved && Math.hypot(e.clientX - fabDrag.x, e.clientY - fabDrag.y) < 8) return;
  fabDrag.moved = true;
  $('.dock').classList.add('dragging');
  fabAt = { fx: e.clientX / innerWidth, fy: e.clientY / innerHeight };
  layoutRing();
});
$('#fab').addEventListener('pointerup', () => {
  $('.dock').classList.remove('dragging');
  if (fabDrag?.moved) store.set('sl8:fab', fabAt);
  else if (fabDrag) openRing(!ringOpen()); // a tap; toggling here works even when a touch browser skips the click
  fabDrag = null;
});
$('#fab').addEventListener('click', (e) => { if (e.detail === 0) openRing(!ringOpen()); }); // keyboard (Enter, Space)
$('#ring-scrim').addEventListener('pointerdown', (e) => { e.preventDefault(); openRing(false); });
// tools with nothing more to choose close the ring; drawing tools keep it open for their colours and sizes
$('nav.bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool], #zoom, #media-add, #music-btn, #mm-btn');
  if (b && ringOpen() && !['pen', 'hl', 'eraser', 'text'].includes(b.dataset.tool)) openRing(false);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && ringOpen()) openRing(false); });
addEventListener('resize', layoutRing);

/* ---------- guided tour: short steps that wait for you to do each thing; Skip at any point ---------- */
function tour() {
  if ($('.tour')) return;
  const touch = matchMedia('(pointer: coarse)').matches, ring = ringOn();
  const count = (k) => [...items.values()].filter((i) => i.kind === k).length;
  const steps = [
    { text: touch ? 'This is your canvas, and it never ends. Move around with two fingers, and pinch to zoom.'
      : 'This is your canvas, and it never ends. Scroll to move around, and hold Ctrl while scrolling to zoom.' },
    ring ? { text: 'Your tools live in this button. Tap it to open them. You can also drag it anywhere.', at: '#fab', done: ringOpen }
      : { text: 'Your tools live in this bar.', at: 'nav.bar' },
    { text: `Pick the pen. Its pen types and colours appear ${ring ? 'in the outer ring' : 'above'}.`, at: '[data-tool="pen"]', done: () => tool.name === 'pen' },
    { text: `${ring ? 'Tap the canvas to close the ring, then write' : 'Now write'} or draw anything.`, done: (b) => count('stroke') > b.stroke },
    { text: `Pick T, the text tool, then ${touch ? 'tap' : 'click'} where you want a note and type.`, at: '[data-tool="text"]', done: (b) => count('text') > b.text },
    { text: 'To link two ideas, pick Connect (the arrow) and drag from one note to the other.', at: '[data-tool="connect"]' },
    { text: 'Each canvas can have its own theme, pattern and background image, and portals into more canvases. It\'s all in this menu.', at: '#menu-open' },
    { text: 'That\'s the basics. You can see this again any time from the ⋯ menu. Think without boundaries.' },
  ];
  const card = document.createElement('div'), spot = document.createElement('div');
  card.className = 'tour';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Guided tour');
  card.innerHTML = '<p class="tour-step"></p><p class="tour-text" aria-live="polite"></p><div class="tour-actions"><button class="btn quiet" type="button">Skip tour</button><button class="btn primary" type="button">Next</button></div>';
  spot.className = 'tour-spot';
  const [skip, next] = card.querySelectorAll('button');
  let i = -1, base = null, timer = 0;
  const end = () => { clearInterval(timer); card.remove(); spot.remove(); };
  const go = (n) => {
    if (n >= steps.length) return end();
    i = n;
    base = { stroke: count('stroke'), text: count('text') };
    card.classList.remove('done');
    card.querySelector('.tour-step').textContent = `${i + 1} of ${steps.length}`;
    card.querySelector('.tour-text').textContent = steps[i].text;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    skip.hidden = i === steps.length - 1;
  };
  const tick = () => {
    const s = steps[i];
    let el = s.at && $(s.at);
    if (el?.classList.contains('ring-item') && !ringOpen()) el = $('#fab'); // its tool is tucked inside the ring
    const r = el?.getBoundingClientRect();
    spot.hidden = !r?.width;
    if (r?.width) Object.assign(spot.style, { left: r.left - 7 + 'px', top: r.top - 7 + 'px', width: r.width + 14 + 'px', height: r.height + 14 + 'px' });
    if (s.done && !card.classList.contains('done') && s.done(base)) { // they did it: tick, then move on
      card.classList.add('done');
      setTimeout(() => i === steps.indexOf(s) && go(i + 1), 700);
    }
  };
  skip.onclick = end;
  next.onclick = () => go(i + 1);
  const begin = () => { // after the opening has torn away
    if ($('.reveal')) return setTimeout(begin, 300);
    document.body.append(spot, card);
    go(0);
    timer = setInterval(tick, 200);
  };
  begin();
}
$('#tour-start').onclick = () => { closeMenu(); tour(); };

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
  if (e.key === 'm') { mmFlip(); return; }
  const map = { v: 'select', p: 'pen', h: 'hl', e: 'eraser', t: 'text', c: 'connect' };
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
    canvasTitles.set(noteId, title);
  } catch (e) {
    toast(e.message);
  }
}
titleEl.addEventListener('change', saveTitle);
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleEl.blur(); });

function updateHint() {
  $('#hint').hidden = items.size > 0 || store.get('sl8:hints') === 'off';
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
// this canvas's look, saved to the canvas so it's the same on every device
let lookTimer;
function setLook(patch) {
  look = { ...look, ...patch };
  for (const k of Object.keys(look)) if (look[k] === undefined || look[k] === null || look[k] === '') delete look[k];
  readPalette();
  applyLook();
  syncLookControls();
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => api(`/api/notes/${noteId}`, { method: 'PATCH', body: { style: look } }).catch((e) => toast(e.message)), 400);
}
function syncLookControls() {
  const cs = getComputedStyle(board);
  for (const r of document.querySelectorAll('input[name=c-theme]')) r.checked = r.value === (look.theme || '');
  for (const r of document.querySelectorAll('input[name=c-pattern]')) r.checked = r.value === (look.pattern || store.get('sl8:bg') || 'dots');
  for (const r of document.querySelectorAll('input[name=c-fit]')) r.checked = r.value === (look.fit || 'cover');
  $('#c-size').value = look.size || 24;
  $('#c-paper').value = look.paper || toHex(getComputedStyle(document.documentElement).getPropertyValue('--paper'));
  $('#c-rule').value = look.rule || toHex(getComputedStyle(document.documentElement).getPropertyValue('--dot'));
  $('#c-image-on').hidden = $('#c-dim-row').hidden = !look.image;
  $('#c-dim').value = look.dim || 0;
}
function toHex(c) { // computed colours come back as #rrggbb or rgb(...)
  c = c.trim();
  if (HEX.test(c)) return c;
  const m = c.match(/\d+/g);
  return m ? '#' + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : '#ffffff';
}
for (const r of document.querySelectorAll('input[name=c-theme]')) r.onchange = () => setLook({ theme: r.value, paper: undefined });
for (const r of document.querySelectorAll('input[name=c-pattern]')) r.onchange = () => setLook({ pattern: r.value });
for (const r of document.querySelectorAll('input[name=c-fit]')) r.onchange = () => setLook({ fit: r.value });
$('#c-size').oninput = (e) => setLook({ size: Number(e.target.value) });
$('#c-paper').oninput = (e) => setLook({ paper: e.target.value });
$('#c-rule').oninput = (e) => setLook({ rule: e.target.value });
$('#c-dim').oninput = (e) => setLook({ dim: Number(e.target.value) });
$('#c-colors-reset').onclick = () => setLook({ paper: undefined, rule: undefined });
$('#c-image-remove').onclick = () => setLook({ image: undefined, dim: undefined, fit: undefined });
// Upload a photo (shrunk to 2560px on its long side, plenty on any screen) or a video; gives its file id and pixel size.
async function upload(file) {
  let blob = file, w, h;
  if (file.type.startsWith('video/')) {
    if (file.size > 25e6) throw new Error('Videos can be up to 25 MB for now, about 20 to 30 seconds from a phone.');
    [w, h] = await new Promise((ok, no) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => { ok([v.videoWidth || 640, v.videoHeight || 360]); URL.revokeObjectURL(v.src); };
      v.onerror = () => no(new Error("That video can't play in this browser. Try an MP4."));
      v.src = URL.createObjectURL(file);
    });
  } else {
    const bmp = await createImageBitmap(file).catch(() => { throw new Error("That picture can't be opened here. Try a JPEG or PNG."); });
    const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = w = Math.round(bmp.width * k); c.height = h = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const keep = /^image\/(png|gif|webp)$/.test(file.type) && k === 1 && file.size < 3e6; // keeps transparency
    if (!keep) blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
  }
  const res = await fetch('/api/files', { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Upload failed.');
  return { id: j.id, w, h };
}
// Put photos and videos on the canvas, centred on a screen point (the middle of the view unless dropped somewhere).
async function addMedia(files, sx = board.clientWidth / 2, sy = board.clientHeight / 2) {
  if (shareToken) return toast("Photos and videos can't be added through a link.");
  files = [...files].filter((f) => /^(image|video)\//.test(f.type));
  if (!files.length) return toast('Choose a photo or a video.');
  toast(files.length > 1 ? `Adding ${files.length} files…` : 'Adding…');
  const added = [];
  for (const [i, file] of files.entries()) {
    try {
      const f = await upload(file);
      const k = Math.min(1, (board.clientWidth * 0.6) / f.w, (board.clientHeight * 0.5) / f.h) / cam.z; // fits the view
      const w = Math.round(f.w * k), h = Math.round(f.h * k), [x, y] = toWorld(sx + i * 24, sy + i * 24);
      const it = { id: crypto.randomUUID(), kind: file.type.startsWith('video/') ? 'video' : 'image', t: Date.now(), file: f.id, x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h };
      commit([{ id: it.id, before: null, after: it }]);
      added.push(it.id);
    } catch (err) { toast(err.message); }
  }
  if (!added.length) return;
  $('#toast').hidden = true;
  setTool('select');
  setSelection(added);
}
$('#media-add').onclick = () => $('#media-file').click();
$('#media-file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; addMedia(f); };
$('#sel-play').onclick = () => { const it = items.get([...selection][0]); if (it?.kind === 'video') toggleVideo(it); schedule(false); };
addEventListener('paste', (e) => { // a copied picture
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || e.target.closest?.('input, textarea')) return;
  e.preventDefault();
  addMedia(files);
});
board.addEventListener('dragover', (e) => e.preventDefault());
board.addEventListener('drop', (e) => { // files dragged in from the desktop
  e.preventDefault();
  if (e.dataTransfer?.files.length) addMedia(e.dataTransfer.files, e.clientX, e.clientY);
});

$('#c-image').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast('Uploading…');
  try {
    const f = await upload(file);
    imageSizes.set(f.id, [f.w, f.h]);
    setLook({ image: f.id, fit: look.fit || 'cover', dim: look.dim ?? 0.15 });
    toast('Background image set.');
  } catch (err) {
    toast(err.message || "Couldn't use that image.");
  }
};

/* ---------- embeds: players and documents from other services on the canvas (list in /embeds.js); music is controlled from the ring ---------- */
let EMBEDS, parseEmbed;
const ctrls = new Map(); // embed id -> Spotify iFrame API controller (the only service with a control API)
let spotifyApi = null;
const withSpotify = (fn) => {
  if (spotifyApi) return fn(spotifyApi);
  if (!window.onSpotifyIframeApiReady) {
    window.onSpotifyIframeApiReady = (api) => { spotifyApi = api; for (const f of withSpotify.q) f(api); withSpotify.q = []; };
    withSpotify.q = [];
    const s = document.createElement('script'); s.src = 'https://open.spotify.com/embed/iframe-api/v1'; s.async = true; document.head.append(s);
  }
  withSpotify.q.push(fn);
};
const spotifyUri = (ref) => 'spotify:' + ref.replace('/', ':');
function renderEmbed(it) {
  const service = it.service || 'spotify', def = EMBEDS[service];
  if (!def) return;
  let el = textEls.get(it.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'embed';
    el.innerHTML = '<div class="embed-bar"><span></span><button type="button" class="embed-use" aria-pressed="false">Use</button></div><div class="embed-host"><div></div></div>';
    el.querySelector('span').textContent = def.label;
    el.querySelector('.embed-use').addEventListener('click', () => { setSelection([it.id]); el.classList.toggle('live'); });
    textsEl.append(el);
    textEls.set(it.id, el);
    el.classList.toggle('selected', selection.has(it.id));
  }
  Object.assign(el.style, { left: it.x + 'px', top: it.y + 'px', width: it.w + 'px', height: it.h + 'px' });
  if (el._ref === it.ref) return;
  const first = !el._ref;
  el._ref = it.ref;
  if (service !== 'spotify') {
    const host = el.querySelector('.embed-host');
    let f = host.querySelector('iframe');
    if (!f) { f = document.createElement('iframe'); f.loading = 'lazy'; f.allow = 'autoplay; encrypted-media; fullscreen; clipboard-write; picture-in-picture'; f.referrerPolicy = 'strict-origin-when-cross-origin'; f.title = def.label; host.replaceChildren(f); }
    f.src = def.src(it.ref, location.hostname);
    return;
  }
  if (!first) { ctrls.get(it.id)?.loadUri(spotifyUri(it.ref)); return; }
  withSpotify((api) => api.createController(el.querySelector('.embed-host > div'), { uri: spotifyUri(it.ref), width: '100%', height: '100%' }, (c) => {
    if (!textEls.has(it.id)) return c.destroy?.();
    ctrls.set(it.id, c);
    c.addListener('playback_update', (e) => { el.classList.toggle('playing', !e.data.isPaused && !e.data.isBuffering); musicSync(); });
  }));
}
const musicSync = () => $('#music-btn').classList.toggle('playing', !!document.querySelector('.embed.playing'));
const activeSpotify = () => { const mine = [...items.values()].filter((i) => i.kind === 'embed' && (i.service || 'spotify') === 'spotify'); return (mine.find((i) => selection.has(i.id)) || mine.sort((a, b) => b.t - a.t)[0])?.id; };
const savedMusic = () => { try { return JSON.parse(localStorage.getItem('sl8:music')) || []; } catch { return []; } };
const saveMusic = (service, ref, name) => { try { localStorage.setItem('sl8:music', JSON.stringify([{ service, ref, name }, ...savedMusic().filter((m) => m.ref !== ref)].slice(0, 30))); } catch {} };
function playLink(service, ref, name) {
  saveMusic(service, ref, name);
  const id = service === 'spotify' && activeSpotify(), it = id && items.get(id); // a new song goes into the Spotify player you already have
  if (it) commit([{ id, before: it, after: { ...it, ref } }]);
  else {
    const [pw, ph] = EMBEDS[service].size(ref), w = pw, h = ph + 26;
    const [x, y] = toWorld(board.clientWidth / 2 - w / 2 * cam.z, board.clientHeight * 0.3);
    const e = { id: crypto.randomUUID(), kind: 'embed', service, t: Date.now(), x: Math.round(x), y: Math.round(y), w, h, ref };
    commit([{ id: e.id, before: null, after: e }]);
    setSelection([e.id]);
  }
  if (service === 'spotify') setTimeout(() => ctrls.get(activeSpotify())?.play?.(), 600);
  renderMusicList();
}
function renderMusicList() {
  $('#music-list').replaceChildren(...savedMusic().filter((m) => EMBEDS[m.service || 'spotify']).map((m) => {
    const svc = m.service || 'spotify', li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.textContent = m.name || `${EMBEDS[svc].label}: ${m.ref.slice(0, 40)}`; b.onclick = () => playLink(svc, m.ref, m.name);
    li.append(b); return li;
  }));
}
$('#music-btn').onclick = () => { closeMenu(); renderMusicList(); $('#music-menu').hidden = !$('#music-menu').hidden; if (!$('#music-menu').hidden) $('#music-link').focus(); };
$('#music-toggle').onclick = () => { const c = ctrls.get(activeSpotify()); if (c) c.togglePlay(); else toast('Add a Spotify link first.'); };
$('#music-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const link = $('#music-link').value, found = parseEmbed(link);
  if (!found) return toast(/pinterest\.com\/[^/]+\/[^/]+/.test(link) ? 'Pinterest boards can\'t be embedded yet; paste a single pin.' : "I can't embed that link. Try Spotify, YouTube, Google Docs, Figma and the others in the list.");
  $('#music-link').value = '';
  let name = '';
  if (found.service === 'spotify') try { name = (await (await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/' + found.ref))).json()).title || ''; } catch {}
  playLink(found.service, found.ref, name);
});
addEventListener('pointerdown', (e) => { if (!$('#music-menu').hidden && !e.target.closest?.('#music-menu, #music-btn')) $('#music-menu').hidden = true; }, true);

/* ---------- adding portals ---------- */
function closePortalMenu() { $('#portal-menu').hidden = true; }
$('#portal-add').onclick = () => {
  closeMenu();
  const others = [...canvasTitles].filter(([id]) => id !== noteId);
  $('#portal-list').replaceChildren(...others.map(([id, title]) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = title;
    b.onclick = () => { closePortalMenu(); addPortal(id); };
    li.append(b);
    return li;
  }));
  $('#portal-menu').hidden = false;
  $('#portal-name').value = '';
  $('#portal-name').focus();
};
$('#portal-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#portal-name').value.trim() || 'Untitled';
  try {
    // a canvas made from here starts with this canvas's look
    const { note } = await api('/api/notes', { method: 'POST', body: { title, style: look } });
    canvasTitles.set(note.id, note.title);
    closePortalMenu();
    addPortal(note.id);
    toast(`Portal to “${note.title}” added. Open it to start writing inside.`);
  } catch (err) { toast(err.message); }
});
addEventListener('pointerdown', (e) => {
  if (!$('#portal-menu').hidden && !e.target.closest?.('#portal-menu, #portal-add')) closePortalMenu();
}, true);

/* ---------- sharing: a link for the whole canvas or for chosen squares of the dot grid, to view or to edit ---------- */
let picking = null; // { cells: Set of "k/col/row", level, adding } while choosing squares
// squares 96 to 192 px on screen at this zoom; once one is picked the size stays, so a share is all one level
const pickLevel = () => (picking.cells.size ? picking.level : Math.max(-4, Math.min(40, Math.ceil(Math.log2(96 / (CELL * cam.z))))));
function pickAt(sx, sy) {
  const c = cellAt(picking.level, ...toWorld(sx, sy));
  if (picking.adding) picking.cells.add(c); else picking.cells.delete(c);
  const n = picking.cells.size;
  $('#pick-done').disabled = !n;
  $('#pick-done').textContent = n ? `Create link (${n})` : 'Create link';
  schedule(false);
}
// the picker's grid and chosen squares, or the squares a link can edit
function paintCells() {
  const d = devicePixelRatio || 1, W = board.clientWidth, H = board.clientHeight;
  lctx.setTransform(d, 0, 0, d, 0, 0);
  lctx.strokeStyle = palette.accent;
  lctx.lineWidth = 1.5;
  if (picking) {
    const s = CELL * 2 ** pickLevel() * cam.z;
    lctx.beginPath();
    for (let x = ((cam.x % s) + s) % s; x < W; x += s) { lctx.moveTo(x, 0); lctx.lineTo(x, H); }
    for (let y = ((cam.y % s) + s) % s; y < H; y += s) { lctx.moveTo(0, y); lctx.lineTo(W, y); }
    lctx.globalAlpha = 0.3;
    lctx.stroke();
    lctx.globalAlpha = 1;
  }
  lctx.fillStyle = palette.accentSoft;
  for (const c of picking ? picking.cells : share.area) {
    const [k, i, j] = c.split('/').map(Number), s = CELL * 2 ** k * cam.z, x = i * s + cam.x, y = j * s + cam.y;
    if (x > W || y > H || x + s < 0 || y + s < 0) continue;
    lctx.fillRect(x, y, s, s);
    lctx.strokeRect(x, y, s, s);
  }
}
function startPicking() {
  picking = { cells: new Set(), level: 0 };
  setSelection([]);
  $('#picker').hidden = false;
  $('#pick-done').disabled = true;
  $('#pick-done').textContent = 'Create link';
  schedule(false);
}
function endPicking() {
  picking = null;
  $('#picker').hidden = true;
  schedule(false);
}
const shareUrl = (token) => `${location.origin}/note?share=${token}`;
const copyLink = (url) => navigator.clipboard?.writeText(url).then(() => toast('Link copied.'), () => {});
async function openShare(made) {
  closeMenu();
  $('#share-menu').hidden = false;
  $('#sh-new').hidden = !made;
  if (made) $('#sh-link').value = shareUrl(made.token);
  try {
    const { shares } = await api(`${notePath}/shares`);
    $('#sh-none').hidden = shares.length > 0;
    $('#sh-list').replaceChildren(...shares.reverse().map((s) => {
      const li = document.createElement('li'), what = document.createElement('span');
      what.textContent = `${s.mode === 'write' ? 'Can edit' : 'Can view'} · ${s.area === '*' ? 'whole canvas' : s.area.length === 1 ? '1 square' : `${s.area.length} squares`}`;
      const btn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn quiet'; b.textContent = label; b.onclick = fn; return b; };
      li.append(what, btn('Copy', () => copyLink(shareUrl(s.token))), btn('Turn off', async () => {
        try { await api(`${notePath}/shares/${s.token}`, { method: 'DELETE' }); openShare(); } catch (e) { toast(e.message); }
      }));
      return li;
    }));
  } catch (e) { toast(e.message); }
}
async function createShare(area) {
  try {
    const { share: s } = await api(`${notePath}/shares`, { method: 'POST', body: { mode: $('input[name=sh-mode]:checked').value, area } });
    await openShare(s);
    copyLink(shareUrl(s.token));
  } catch (e) {
    if (e.kind !== 'verify') return toast(e.message);
    await openShare();
    $('#sh-verify span').textContent = e.message; // sharing needs a confirmed email
    $('#sh-verify').hidden = false;
  }
}
$('#sh-resend').onclick = async () => {
  try { await api('/api/verify/resend', { method: 'POST' }); toast('Sent. Open the link in the email, then share again.'); } catch (e) { toast(e.message); }
};
$('#share-open').onclick = () => { $('#sh-verify').hidden = true; openShare(); };
$('#sh-create').onclick = () => {
  if ($('input[name=sh-area]:checked').value === '*') return createShare('*');
  $('#share-menu').hidden = true;
  startPicking();
};
$('#sh-copy').onclick = () => copyLink($('#sh-link').value);
$('#pick-cancel').onclick = endPicking;
$('#pick-done').onclick = () => { const cells = [...picking.cells]; endPicking(); createShare(cells); };
addEventListener('pointerdown', (e) => {
  if (!$('#share-menu').hidden && !e.target.closest?.('#share-menu, #menu')) $('#share-menu').hidden = true;
}, true);
// the squares a link can edit, in view when it first opens on this device
function fitCells(cells) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const c of cells) {
    const [k, i, j] = c.split('/').map(Number), s = CELL * 2 ** k;
    b.x0 = Math.min(b.x0, i * s); b.y0 = Math.min(b.y0, j * s); b.x1 = Math.max(b.x1, (i + 1) * s); b.y1 = Math.max(b.y1, (j + 1) * s);
  }
  const z = Math.max(0.1, Math.min(2, 0.8 * Math.min(board.clientWidth / (b.x1 - b.x0), board.clientHeight / (b.y1 - b.y0))));
  cam = { z, x: board.clientWidth / 2 - ((b.x0 + b.x1) / 2) * z, y: board.clientHeight / 2 - ((b.y0 + b.y1) / 2) * z };
  camChanged();
}

// back to the canvas this one was opened from
function showTrail() {
  const t = trail();
  while (t.length && t.at(-1).id === noteId) t.pop(); // came back the way we went in
  setTrail(t);
  const parent = t.at(-1);
  $('#trail').hidden = !parent;
  if (!parent) return;
  $('#trail-title').textContent = canvasTitles.get(parent.id) || parent.title || 'Back';
  $('#trail').onclick = () => { setTrail(t.slice(0, -1)); leaveTo('/note?id=' + encodeURIComponent(parent.id)); };
}

/* ---------- arrow labels ---------- */
function editLabel(id) {
  const c = items.get(id), e = c && connEnds(c);
  if (!e) return;
  setSelection([id]);
  const input = document.createElement('input');
  input.className = 'conn-label';
  input.setAttribute('list', 'conn-presets'); // suggestions for the kind of link; anything can still be typed
  input.value = c.label || '';
  input.placeholder = 'Label';
  input.maxLength = 80;
  input.style.left = ((e[0][0] + e[1][0]) / 2) * cam.z + cam.x + 'px';
  input.style.top = ((e[0][1] + e[1][1]) / 2) * cam.z + cam.y + 'px';
  document.body.append(input);
  input.focus();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const label = input.value.trim();
    input.remove();
    const cur = items.get(id);
    if (save && cur && label !== (cur.label || '')) commit([{ id, before: cur, after: { ...cur, label: label || undefined } }]);
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); ev.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
}

$('#sel-del').onclick = deleteSelection;

/* ---------- the opening: the upright 8 from the logo, stretched until the page tears open on the canvas ---------- */
function reveal() {
  let asked = null;
  try { asked = sessionStorage.getItem('sl8:reveal'); sessionStorage.removeItem('sl8:reveal'); } catch {}
  if (!asked) return;
  const mode = store.get('sl8:revealMode') || 'full'; // full: waits for you to stretch it; short ("Quick"): plays by itself
  if (mode === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const tearSound = tearSoundPlayer();

  const el = document.createElement('div');
  el.className = 'reveal';
  el.innerHTML = `<div class="half half-t"><i class="rim"></i><i class="sheet"></i></div>
    <div class="half half-b"><i class="rim"></i><i class="sheet"></i><p class="reveal-hint" hidden>Put a finger in each loop and stretch</p><button class="reveal-skip" type="button" hidden>Skip</button></div>${eightMark('reveal-8')}`;
  document.body.append(el);
  const svg = el.querySelector('svg'), loops = [svg.querySelector('.loop-t'), svg.querySelector('.loop-b')];
  const [rimT, sheetT, rimB, sheetB] = el.querySelectorAll('.rim, .sheet');

  // a ragged line across the middle of the page: [x as a fraction of the width, y px from the middle, fibre depth above, below]
  const line = [];
  for (let x = 0, wander = 0; x < 1; x += (8 + Math.random() * 10) / innerWidth) {
    wander = Math.max(-16, Math.min(16, wander + (Math.random() - 0.5) * 9));
    line.push([x, wander + (Math.random() - 0.5) * 7, 2 + Math.random() * 5, 2 + Math.random() * 4]);
  }
  line.push([1, line.at(-1)[1], 3, 3]);
  // r (0..1): how far the rip has run out from behind the 8 towards the edges, and how wide it has opened
  const rip = (r) => {
    const W = innerWidth, run = r * (W / 2 + 80), gap = r * 12;
    const edge = (side, rim) => line.map(([x, y, up, down]) => {
      const g = gap * Math.max(0, Math.min(1, (run - Math.abs(x * W - W / 2)) / 70));
      // the top sheet overlaps the bottom by 2px so no seam shows before the rip; each rim hides 2px behind its sheet until fibres show
      const fibre = rim ? (side < 0 ? up : down) * Math.min(1, g / 3) - 2 : 0;
      const off = side * (g / 2 - fibre) + (side < 0 ? 2 : 0);
      return `${(x * 100).toFixed(2)}% calc(50% + ${(y + off).toFixed(1)}px)`;
    }).join(',');
    sheetT.style.clipPath = `polygon(0 0,${edge(-1)},100% 0)`;
    rimT.style.clipPath = `polygon(0 0,${edge(-1, 1)},100% 0)`;
    sheetB.style.clipPath = `polygon(${edge(1)},100% 100%,0 100%)`;
    rimB.style.clipPath = `polygon(${edge(1, 1)},100% 100%,0 100%)`;
  };
  rip(0);

  // t (0..1): tension. The loops follow the fingers; the first 62% only stretches the 8, then the page rips; at 1 it tears through.
  const reach = () => Math.max(174, innerHeight * 0.29); // px of extra finger distance to tear
  const RIP = 0.62;
  let t = 0, gone = false, frame = 0;
  const timers = [];
  const pull = (v) => {
    t = v;
    stretch8(svg, (v * reach()) / 2 / svg.getScreenCTM().a);
    rip(Math.max(0, (v - RIP) / (1 - RIP)));
    if (v >= 1) tear();
  };
  const tween = (to, ms, ease) => { // animate the tension (auto play, spring back)
    cancelAnimationFrame(frame);
    const from = t, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      pull(from + (to - from) * ease(k));
      if (k < 1 && !gone) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };
  const smooth = (k) => k * k * (3 - 2 * k), back = (k) => 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2;
  const finish = () => !gone && tween(1, 380, (k) => k * k);
  const tear = () => {
    if (gone) return;
    gone = true;
    cancelAnimationFrame(frame);
    timers.forEach(clearTimeout);
    removeEventListener('keydown', finish);
    tearSound();
    rip(1);
    el.classList.add('torn'); // the halves fly apart (CSS); each loop goes with its half
    const u = (reach() / 2) / svg.getScreenCTM().a, fly = (innerHeight * 0.8) / svg.getScreenCTM().a;
    loops[0].style.transform = `translateY(${-(u + fly)}px)`;
    loops[1].style.transform = `translateY(${u + fly}px)`;
    setTimeout(() => el.remove(), 800);
  };
  el.querySelector('.reveal-skip').onclick = finish;
  addEventListener('keydown', finish);

  if (mode === 'short') { // "Quick" in Settings: it stretches and tears by itself
    tween(1, 420, smooth);
    el.addEventListener('pointerdown', finish);
    return;
  }

  // it waits for you: a finger in each loop (or one loop dragged with a mouse or pen), stretched until the page tears
  const hint = el.querySelector('.reveal-hint');
  if (!matchMedia('(pointer: coarse)').matches) hint.textContent = 'Drag a loop to stretch it';
  timers.push(setTimeout(() => { hint.hidden = false; el.querySelector('.reveal-skip').hidden = false; }, 700));
  const fingers = new Map(); // pointerId -> { loop, x, y }
  let start = 0, anchor = null; // a mouse or pen holds one loop; the other loop's spot is the anchor
  const hole = (i) => {
    const m = svg.getScreenCTM(), u = (t * reach()) / 2 / m.a;
    return { x: m.e, y: m.f + (i ? 1 : -1) * (80 + u) * m.d };
  };
  const holeAt = (x, y) => { // nearest free loop; anywhere on or inside it counts
    const taken = [...fingers.values()].map((f) => f.loop), r = 120 * svg.getScreenCTM().a;
    return [0, 1].map((i) => ({ i, d: Math.hypot(x - hole(i).x, y - hole(i).y) }))
      .sort((a, b) => a.d - b.d).find((h) => h.d < r && !taken.includes(h.i))?.i ?? -1;
  };
  const grips = () => { // the two points being pulled apart, once there are two
    const f = [...fingers.values()];
    return f.length === 2 ? f : f.length === 1 && anchor ? [f[0], anchor] : null;
  };
  const apart = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.reveal-skip')) return;
    const loop = holeAt(e.clientX, e.clientY);
    if (loop < 0) return;
    el.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, { loop, x: e.clientX, y: e.clientY });
    loops[loop].classList.add('held');
    if (e.pointerType !== 'touch') anchor = hole(1 - loop);
    const g = grips();
    svg.classList.toggle('taut', !!g);
    if (g) {
      cancelAnimationFrame(frame);
      start = apart(g) - t * reach(); // keep any stretch still springing back
    }
  });
  el.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (!f || gone) return;
    f.x = e.clientX; f.y = e.clientY;
    const g = grips();
    if (g) pull(Math.min(1, Math.max(0, apart(g) - start) / reach()));
  });
  const lift = (e) => {
    const f = fingers.get(e.pointerId);
    if (!f || gone) return;
    fingers.delete(e.pointerId);
    if (e.pointerType !== 'touch') anchor = null;
    loops[f.loop].classList.remove('held');
    svg.classList.remove('taut');
    tween(0, 520, back); // not far enough: it springs back together
  };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
}

/* ---------- start ---------- */
async function start() {
  if (!noteId && !shareToken) { location.replace('/'); return; }
  reveal();
  document.documentElement.classList.remove('opening');
  ({ EMBEDS, parseEmbed } = await import('/embeds.js'));
  readPalette();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readPalette(); schedule(true); });
  new MutationObserver(() => { readPalette(); schedule(true); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setTool(store.get('sl8:tool') || 'select');
  new ResizeObserver(resize).observe(board);
  let arrived = false;
  try { arrived = sessionStorage.getItem('sl8:arrive') === '1'; sessionStorage.removeItem('sl8:arrive'); } catch {}
  if (arrived) board.animate([{ transform: 'scale(.35)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' });
  try {
    const [{ note, items: list, now, share: linked }, { notes }] = await Promise.all([
      api(notePath),
      shareToken ? { notes: [] } : api('/api/notes').catch(() => ({ notes: [] })), // titles for portals; portals show "deleted" without them
    ]);
    for (const n of notes) canvasTitles.set(n.id, n.title);
    if (linked) { // opened from a link: only what it allows
      share = linked;
      document.documentElement.dataset.share = share.mode; // hides account features (and every tool, for view links)
      if (share.mode === 'read') $('#hint').textContent = 'Nothing has been written here yet.';
      titleEl.readOnly = true;
      setTool(tool.name);
      if (share.area !== '*' && !store.get('sl8:cam:' + canvasKey)) fitCells(share.area);
    }
    look = note.style || {};
    applyLook();
    readPalette();
    syncLookControls();
    titleEl.value = savedTitle = note.title;
    document.title = note.title + ' · ThinkSL8';
    for (const it of list) apply(it.id, it, false);
    for (const [id, it] of store.get(pendingKey) || []) apply(id, it); // changes that never reached the server
    setStatus(share?.mode === 'read' ? 'View only' : pending.size ? 'Saving…' : 'Saved');
    updateHint();
    if (!shareToken) showTrail();
    since = now;
    poll();
    try { if (sessionStorage.getItem('sl8:tour')) { sessionStorage.removeItem('sl8:tour'); tour(); } } catch {} // chosen during setup
    schedule(true);
    const target = location.hash.match(/^#item-([\w-]+)$/)?.[1];
    if (target) requestAnimationFrame(() => focusItem(target));
    const msg = aiReturnMessage();
    if (msg) { toast(msg); if (/connected/.test(msg)) window.openAI?.(); }
  } catch (e) {
    if (e.status === 401) return location.replace('/');
    setStatus(e.status === 404 ? 'Not found' : 'Could not load', 'error');
    toast(e.status === 404 && !shareToken ? 'This canvas does not exist or belongs to another account.' : e.message);
  }
}
start();
