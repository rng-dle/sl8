// A colour picker that replaces the browser's own colour dialog on every <input type="color">.
// The input stays the source of truth: the picker sets its value and fires input (while dragging) and change (when done).
(() => {
  const PRESETS = ['#e03131', '#f76707', '#f59f00', '#94d82d', '#2f9e44', '#0c8599', '#1c7ed6', '#4263eb', '#7048e8', '#c2255c', '#7a4a2a', '#ffffff', '#ced4da', '#868e96', '#343a40', '#000000'];
  const RECENT = 'sl8:recentColors';
  const recent = () => { try { const r = JSON.parse(localStorage.getItem(RECENT)); return Array.isArray(r) ? r.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8) : []; } catch { return []; } };
  const remember = (c) => { try { localStorage.setItem(RECENT, JSON.stringify([c, ...recent().filter((x) => x !== c)].slice(0, 8))); } catch {} };
  const toHex = ({ h, s, v }) => { const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); }; return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join(''); };
  const toHsv = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
    const h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s: mx === 0 ? 0 : d / mx, v: mx };
  };
  const norm = (t) => { t = String(t).trim().replace(/^#/, '').toLowerCase(); if (/^[0-9a-f]{3}$/.test(t)) t = [...t].map((c) => c + c).join(''); return /^[0-9a-f]{6}$/.test(t) ? '#' + t : null; };

  const style = document.createElement('style');
  style.textContent = `
  .cp { position: fixed; z-index: 2000; width: 252px; padding: 12px; border-radius: 16px; background: var(--surface, #fff); color: var(--text, #1c2030); border: 1px solid var(--line, #e1e4ee); box-shadow: 0 12px 40px rgba(0,0,0,.22); font: 600 13px/1.2 var(--font-ui, system-ui, sans-serif); touch-action: none; user-select: none; -webkit-user-select: none; }
  .cp[hidden] { display: none; }
  .cp-sv, .cp-hue { position: relative; border-radius: 10px; cursor: crosshair; touch-action: none; }
  .cp-sv { height: 150px; }
  .cp-hue { height: 14px; margin: 12px 0; background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
  .cp-dot { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.35); pointer-events: none; }
  .cp-hue .cp-dot { top: 50%; }
  .cp-row { display: flex; gap: 8px; align-items: center; }
  .cp-now { flex: none; width: 36px; height: 36px; border-radius: 10px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.18); }
  .cp-hex { flex: 1; min-width: 0; height: 36px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--line, #e1e4ee); background: var(--paper, #f7f8fb); color: inherit; font: 600 14px/1 ui-monospace, Menlo, Consolas, monospace; text-transform: uppercase; }
  .cp-hex:focus-visible { outline: 2px solid #4263eb; outline-offset: 1px; }
  .cp-hex.bad { border-color: #e03131; }
  .cp-eye { flex: none; width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--line, #e1e4ee); background: var(--paper, #f7f8fb); color: inherit; cursor: pointer; font-size: 16px; }
  .cp-label { margin: 12px 0 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted, #60667d); }
  .cp-sw { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; }
  .cp-sw button { aspect-ratio: 1; border-radius: 50%; border: 0; padding: 0; cursor: pointer; box-shadow: inset 0 0 0 1px rgba(0,0,0,.2); }
  .cp-sw button:hover { transform: scale(1.12); }
  .cp-sw button:focus-visible { outline: 2px solid #4263eb; outline-offset: 2px; }
  @media (max-width: 520px) { .cp { left: 50% !important; top: auto !important; bottom: calc(env(safe-area-inset-bottom, 0px) + 12px); transform: translateX(-50%); width: min(340px, calc(100vw - 24px)); } .cp-sv { height: 190px; } .cp-dot { width: 22px; height: 22px; margin: -11px 0 0 -11px; } }`;
  document.head.append(style);

  const el = document.createElement('div');
  el.className = 'cp'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Pick a colour');
  el.innerHTML = `<div class="cp-sv"><i class="cp-dot"></i></div><div class="cp-hue"><i class="cp-dot"></i></div>
    <div class="cp-row"><span class="cp-now"></span><input class="cp-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Hex colour"><button class="cp-eye" type="button" aria-label="Pick from screen" title="Pick a colour from the screen" hidden>⌖</button></div>
    <div class="cp-label">Recent</div><div class="cp-sw cp-recent"></div><div class="cp-label">Colours</div><div class="cp-sw cp-presets"></div>`;
  document.body.append(el);
  const $ = (s) => el.querySelector(s), sv = $('.cp-sv'), hue = $('.cp-hue'), hex = $('.cp-hex'), now = $('.cp-now');
  let input = null, hsv = { h: 0, s: 0, v: 0 }, dirty = false;

  const paint = () => {
    const c = toHex(hsv);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`;
    sv.firstElementChild.style.left = hsv.s * 100 + '%'; sv.firstElementChild.style.top = (1 - hsv.v) * 100 + '%';
    hue.firstElementChild.style.left = (hsv.h / 360) * 100 + '%'; hue.firstElementChild.style.background = `hsl(${hsv.h} 100% 50%)`;
    now.style.background = c; if (document.activeElement !== hex) { hex.value = c.slice(1); hex.classList.remove('bad'); }
    return c;
  };
  const fire = (type) => input && input.dispatchEvent(new Event(type, { bubbles: true }));
  const apply = (live = true) => { const c = paint(); if (input && input.value !== c) { input.value = c; dirty = true; fire('input'); } if (!live) commit(); };
  const commit = () => { if (input && dirty) { remember(toHex(hsv)); fire('change'); dirty = false; } };
  const swatches = (box, list) => { box.replaceChildren(...list.map((c) => { const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', c); b.onclick = () => { hsv = toHsv(c); apply(false); }; return b; })); };
  const drag = (box, set) => box.addEventListener('pointerdown', (e) => {
    e.preventDefault(); box.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = box.getBoundingClientRect(); set(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))); apply(); };
    move(e); box.addEventListener('pointermove', move);
    const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up); commit(); };
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
  });
  drag(sv, (x, y) => { hsv.s = x; hsv.v = 1 - y; });
  drag(hue, (x) => { hsv.h = x * 360; });
  hex.addEventListener('input', () => { const c = norm(hex.value); hex.classList.toggle('bad', !c); if (c) { hsv = toHsv(c); apply(); } });
  hex.addEventListener('change', commit);
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); close(); } });
  if (window.EyeDropper) { const eye = $('.cp-eye'); eye.hidden = false; eye.onclick = async () => { try { const { sRGBHex } = await new EyeDropper().open(); hsv = toHsv(norm(sRGBHex)); apply(false); } catch {} }; }

  const place = () => {
    const r = input.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
    el.style.top = Math.max(8, r.bottom + 8 + h > innerHeight ? r.top - h - 8 : r.bottom + 8) + 'px';
  };
  const open = (i) => {
    if (input === i && !el.hidden) return close();
    commit(); input = i; dirty = false;
    hsv = toHsv(norm(i.value) || '#000000');
    swatches($('.cp-recent'), recent()); swatches($('.cp-presets'), PRESETS);
    $('.cp-recent').previousElementSibling.hidden = $('.cp-recent').hidden = !recent().length;
    el.hidden = false; paint(); place();
  };
  const close = () => { commit(); el.hidden = true; input = null; };
  document.addEventListener('click', (e) => { const i = e.target.closest?.('input[type=color]'); if (i && !el.contains(i)) { e.preventDefault(); open(i); } }, true);
  document.addEventListener('pointerdown', (e) => { if (!el.hidden && !el.contains(e.target) && !e.target.closest?.('input[type=color], label:has(input[type=color])')) close(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) { e.stopPropagation(); close(); } }, true);
  addEventListener('resize', () => { if (!el.hidden) place(); });
})();
