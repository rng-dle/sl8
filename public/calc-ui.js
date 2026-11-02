// The scientific calculator panel on the canvas. Engine: /calc.js. Loaded the first time the toolbar button is used.
import { evaluate, format, CalcError } from '/calc.js';

const KEY = 'sl8:calc';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

const css = `
#calc { position: fixed; z-index: 31; right: 12px; top: calc(env(safe-area-inset-top, 0px) + 64px); width: min(340px, calc(100vw - 24px)); max-height: calc(100dvh - 80px); overflow-y: auto;
  display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); font-family: var(--font-ui); user-select: none; -webkit-user-select: none; touch-action: none; }
#calc[hidden] { display: none; }
#calc .c-head { display: flex; align-items: center; gap: 8px; cursor: grab; }
#calc .c-head b { flex: 1; font: 400 17px/1.2 var(--font-display); margin: 0; }
#calc .c-mini { height: 26px; padding: 0 10px; border: 1px solid var(--line); border-radius: 999px; background: none; color: var(--text); font: 700 11px/1 var(--font-ui); letter-spacing: .06em; cursor: pointer; }
#calc .c-mini[aria-pressed="true"], #calc .c-mem { background: var(--accent); color: #fff; border-color: var(--accent); }
#calc .c-screen { display: grid; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); user-select: text; -webkit-user-select: text; }
#calc input { width: 100%; border: 0; outline: 0; background: none; color: var(--text); font: 600 20px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 0; }
#calc .c-out { min-height: 24px; text-align: right; font: 700 24px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; white-space: nowrap; }
#calc .c-out.err { font: 600 13px/1.4 var(--font-ui); color: #c0392b; }
#calc .c-out.live { color: var(--muted); font-size: 18px; }
#calc .c-hist { display: grid; max-height: 84px; overflow-y: auto; font: 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
#calc .c-hist:empty { display: none; }
#calc .c-hist button { display: flex; justify-content: space-between; gap: 12px; padding: 3px 4px; border: 0; background: none; color: var(--muted); cursor: pointer; text-align: left; }
#calc .c-hist button:hover { color: var(--accent); }
#calc .c-pad { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
#calc .c-pad button { height: 38px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); color: var(--text); font: 600 14px/1 var(--font-ui); cursor: pointer; touch-action: manipulation; }
#calc .c-pad button:active { transform: scale(.96); }
#calc .c-pad .num { background: var(--surface); font-size: 17px; }
#calc .c-pad .op { color: var(--accent); font-size: 17px; }
#calc .c-pad .eq { grid-column: span 3; background: var(--accent); color: #fff; border-color: var(--accent); font-size: 20px; }
#calc .c-pad .on { background: var(--accent); color: #fff; border-color: var(--accent); }
#calc .c-actions { display: flex; gap: 8px; }
#calc .c-actions button { flex: 1; height: 34px; border: 1px solid var(--line); border-radius: 10px; background: none; color: var(--text); font: 600 13px/1 var(--font-ui); cursor: pointer; }
`;

// [label, insert text, class] and, in inverse mode, [label, insert text]
const PAD = [
  ['2nd', '@inv', 'fn'], ['π', 'π', 'fn'], ['e', 'e', 'fn'], ['AC', '@clear', 'fn'], ['⌫', '@back', 'fn'],
  ['sin', 'sin(', 'fn', 'sin⁻¹', 'asin('], ['cos', 'cos(', 'fn', 'cos⁻¹', 'acos('], ['tan', 'tan(', 'fn', 'tan⁻¹', 'atan('], ['ln', 'ln(', 'fn', 'eˣ', 'exp('], ['log', 'log(', 'fn', '10ˣ', '10^('],
  ['x²', '^2', 'fn', 'x³', '^3'], ['xʸ', '^', 'fn', 'ʸ√x', 'root('], ['√', 'sqrt(', 'fn', '∛', 'cbrt('], ['(', '(', 'fn'], [')', ')', 'fn'],
  ['n!', '!', 'fn'], ['nCr', 'nCr(', 'fn', 'nPr', 'nPr('], ['%', '%', 'fn'], ['Ans', 'ans', 'fn'], [',', ',', 'fn'],
  ['MC', '@mc', 'fn'], ['MR', 'm', 'fn'], ['M+', '@m+', 'fn'], ['M−', '@m-', 'fn'], ['1/x', '@recip', 'fn'],
  ['7', '7', 'num'], ['8', '8', 'num'], ['9', '9', 'num'], ['÷', '÷', 'op'], ['×', '×', 'op'],
  ['4', '4', 'num'], ['5', '5', 'num'], ['6', '6', 'num'], ['−', '−', 'op'], ['+', '+', 'op'],
  ['1', '1', 'num'], ['2', '2', 'num'], ['3', '3', 'num'], ['±', '@sign', 'fn'], ['EXP', '×10^', 'fn'],
  ['0', '0', 'num'], ['.', '.', 'num'], ['=', '@eval', 'eq'],
];

export function mount({ insert, toast }) {
  const st = { angle: 'deg', memory: 0, ans: 0, history: [], ...load() };
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  const el = document.createElement('div');
  el.id = 'calc'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Scientific calculator');
  el.innerHTML = `<div class="c-head"><b>Calculator</b><button type="button" class="c-mini c-mem" hidden title="Something is in memory">M</button>
    <button type="button" class="c-mini c-angle" title="Angle unit for sin, cos, tan"></button><button type="button" class="c-mini c-x" aria-label="Close" title="Close (Esc)">✕</button></div>
    <div class="c-screen"><input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Expression" placeholder="0"><div class="c-out" aria-live="polite"></div></div>
    <div class="c-hist"></div><div class="c-pad"></div>
    <div class="c-actions"><button type="button" class="c-put">Put on canvas</button><button type="button" class="c-copy">Copy result</button></div>`;
  document.body.append(el);
  const $ = (s) => el.querySelector(s);
  const input = $('input'), out = $('.c-out'), pad = $('.c-pad'), hist = $('.c-hist'), angleBtn = $('.c-angle'), memBtn = $('.c-mem');
  if (matchMedia('(pointer: coarse)').matches) input.inputMode = 'none'; // touch: use the keys, not the phone keyboard
  let inverse = false, last = null; // last: { expr, result } of the latest '='

  const persist = () => save({ angle: st.angle, memory: st.memory, ans: st.ans, history: st.history.slice(0, 30) });
  const ctx = () => ({ angle: st.angle, ans: st.ans, memory: st.memory });
  const run = (expr) => evaluate(expr, ctx());
  const shortOut = (msg, cls = '') => { out.className = 'c-out ' + cls; out.textContent = msg; };

  function paint() {
    angleBtn.textContent = st.angle.toUpperCase();
    memBtn.hidden = !st.memory;
    pad.querySelectorAll('button').forEach((b) => {
      const k = PAD.find((p) => p[0] === b.dataset.k || p[3] === b.dataset.k);
      if (!k || !k[3]) return;
      b.textContent = inverse ? k[3] : k[0]; b.dataset.k = inverse ? k[3] : k[0];
    });
    pad.querySelector('[data-k="2nd"]').classList.toggle('on', inverse);
    hist.replaceChildren(...st.history.slice(0, 8).map((h) => {
      const b = document.createElement('button'); b.type = 'button';
      const a = document.createElement('span'), r = document.createElement('span'); a.textContent = h.expr; r.textContent = '= ' + h.result;
      b.append(a, r); b.title = 'Use this again'; b.onclick = () => { input.value = h.expr; preview(); input.focus(); }; return b;
    }));
  }
  function preview() {
    const v = input.value.trim();
    if (!v) return shortOut('');
    try { shortOut(format(run(v)), 'live'); } catch { shortOut(''); } // half-typed input isn't an error yet
  }
  function put(text) { // insert at the caret, replacing any selection
    const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + text + input.value.slice(b);
    const at = a + text.length; input.setSelectionRange(at, at);
    preview();
  }
  function equals() {
    const expr = input.value.trim();
    if (!expr) return;
    try {
      const v = run(expr), result = format(v);
      st.ans = v; last = { expr, result };
      st.history.unshift({ expr, result }); persist();
      shortOut(result);
      input.value = result; input.setSelectionRange(result.length, result.length);
      paint();
    } catch (e) { shortOut(e instanceof CalcError ? e.message : 'Something went wrong', 'err'); }
  }
  const current = () => { try { return run(input.value.trim() || String(st.ans)); } catch { return null; } };
  const ACTIONS = {
    '@inv': () => { inverse = !inverse; paint(); },
    '@clear': () => { input.value = ''; last = null; shortOut(''); },
    '@back': () => { const a = input.selectionStart, b = input.selectionEnd; if (a !== b) put(''); else if (a > 0) { input.value = input.value.slice(0, a - 1) + input.value.slice(a); input.setSelectionRange(a - 1, a - 1); preview(); } },
    '@eval': equals,
    '@mc': () => { st.memory = 0; persist(); paint(); },
    '@m+': () => { const v = current(); if (v == null) return shortOut('Nothing to add to memory', 'err'); st.memory += v; persist(); paint(); },
    '@m-': () => { const v = current(); if (v == null) return shortOut('Nothing to take from memory', 'err'); st.memory -= v; persist(); paint(); },
    '@recip': () => { if (input.value.trim()) { input.value = `1/(${input.value.trim()})`; preview(); } else put('1/('); },
    '@sign': () => { const m = input.value.match(/(\d+\.?\d*|\.\d+)$/); if (m) { input.value = input.value.slice(0, m.index) + `(−${m[0]})`; preview(); } else put('−'); },
  };

  for (const p of PAD) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = p[0]; b.dataset.k = p[0];
    if (p[2] && p[2] !== 'fn') b.className = p[2];
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret in the field
    b.addEventListener('click', () => {
      const key = inverse && p[3] ? p[4] : p[1];
      if (key.startsWith('@')) return ACTIONS[key]();
      if (last && input.value === last.result && /^[+\-*/^×÷−]/.test(key)) last = null; // continuing from a result: keep it
      else if (last && input.value === last.result && /^[\d.π(]|^[a-z]/i.test(key) && !/^[%!]/.test(key)) input.value = ''; // a fresh number starts over
      put(key);
      if (inverse && key !== '@inv' && p[3]) { inverse = false; paint(); }
    });
    pad.append(b);
  }
  input.addEventListener('input', () => { last = null; preview(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); equals(); }
    else if (e.key === 'Escape') { e.preventDefault(); api.hide(); }
  });
  angleBtn.onclick = () => { st.angle = st.angle === 'deg' ? 'rad' : st.angle === 'rad' ? 'grad' : 'deg'; persist(); paint(); preview(); };
  memBtn.onclick = () => put('m');
  $('.c-x').onclick = () => api.hide();
  $('.c-put').onclick = () => {
    let expr = input.value.trim(), result = last?.result;
    if (!result || last.result !== expr) { // not just evaluated: evaluate what is typed
      try { const v = run(expr); result = format(v); st.ans = v; st.history.unshift({ expr, result }); persist(); paint(); } catch (e) { return shortOut(e instanceof CalcError ? e.message : 'Nothing to put yet', 'err'); }
    } else expr = last.expr;
    insert(expr === result ? result : `${expr} = ${result}`);
  };
  $('.c-copy').onclick = async () => {
    const v = current(); if (v == null) return shortOut('Nothing to copy', 'err');
    const text = format(v);
    try { await navigator.clipboard.writeText(text); toast?.('Copied ' + text); } catch { input.select(); toast?.('Press Ctrl+C to copy'); }
  };

  // drag by the header
  const head = $('.c-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId); head.style.cursor = 'grabbing';
    const move = (m) => {
      el.style.right = 'auto';
      el.style.left = Math.max(0, Math.min(innerWidth - 80, m.clientX - dx)) + 'px';
      el.style.top = Math.max(0, Math.min(innerHeight - 60, m.clientY - dy)) + 'px';
    };
    const up = () => { head.style.cursor = ''; head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  el.addEventListener('pointerdown', (e) => e.stopPropagation()); // clicks here are not clicks on the canvas

  const api = {
    show() { el.hidden = false; paint(); preview(); if (!matchMedia('(pointer: coarse)').matches) input.focus(); },
    hide() { el.hidden = true; document.getElementById('calc-btn')?.setAttribute('aria-pressed', 'false'); },
    toggle() { el.hidden ? api.show() : api.hide(); document.getElementById('calc-btn')?.setAttribute('aria-pressed', String(!el.hidden)); },
  };
  paint();
  return api;
}
