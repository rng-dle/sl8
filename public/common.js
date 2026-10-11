// Shared by every page: JSON API calls, toast, per-device preferences, theme, the infinity mark.
async function api(path, { method = 'GET', body, keepalive } = {}) {
  const opts = { method, keepalive, headers: {} };
  if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error("Can't reach ThinkSL8. Check your connection and try again."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status, kind: data.kind });
  return data;
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const THEMES = ['light', 'dark', 'paper', 'blueprint', 'chalk'];
function fileUrl(id) { return '/api/files/' + encodeURIComponent(id); } // an uploaded image
function go(href) { location.href = href; }
function applyTheme(t) {
  if (THEMES.includes(t)) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// Logo colours (Settings, this device): the tab icon, the icon when ThinkSL8 is installed, and the opening.
const LOGO = { bg: '#0a2b48', fg: '#78d1f9' };
function applyLogo(c = store.get('sl8:logo')) {
  const custom = /^#[0-9a-f]{6}$/i.test(c?.bg) && /^#[0-9a-f]{6}$/i.test(c?.fg);
  const { bg, fg } = custom ? c : LOGO, q = `?bg=${bg.slice(1)}&fg=${fg.slice(1)}`;
  const link = (rel, plain, colored) => { const l = document.querySelector(`link[rel="${rel}"]`); if (l) l.href = custom ? colored + q : plain; };
  link('icon', '/favicon.svg', '/api/logo/favicon.svg');
  link('apple-touch-icon', '/apple-touch-icon.png', '/api/logo/apple-touch-icon.png');
  link('manifest', '/manifest.webmanifest', '/api/logo/manifest');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  document.documentElement.style.setProperty('--logo-bg', bg);
  document.documentElement.style.setProperty('--logo-fg', fg);
  // a tear shows pale fibres on dark paper and a shadowed edge on light paper
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
  document.documentElement.style.setProperty('--logo-rim', `color-mix(in srgb, ${bg} ${light ? '78%, #000' : '12%, #fff'})`);
}
applyLogo();

// The SL8 mark: an S of two half discs, an upright bar, and an 8 of two rings where one strand
// passes over the other (the two curved cuts in the mask). Drawn in currentColor.
let markSeq = 0;
function sl8Mark(cls = 'mark', label = 'SL8') {
  const id = 'sl8-cut-' + markSeq++;
  return `<svg class="${cls}" viewBox="0 0 457 380" role="img" aria-label="${label}"><defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="457" height="380"><rect width="457" height="380" fill="#fff"/><path d="M244.9 223.3A110.5 110.5 0 0 1 329.6 160.6M445.1 156.7A110.5 110.5 0 0 1 360.4 219.4" fill="none" stroke="#000" stroke-width="8"/></mask></defs><path fill="currentColor" d="M98 13A95 95 0 0 0 98 203ZM98 177A95 95 0 0 1 98 367ZM190 13h49.5v354H190Z"/><g fill="none" stroke="currentColor" stroke-width="48" mask="url(#${id})"><circle cx="345" cy="110" r="81.5"/><circle cx="345" cy="270" r="81.5"/></g></svg>`;
}
// The 8 from the mark, upright: used for animations. Each loop is its own group (with its own cut) so the
// two can be pulled apart; the strands between them are drawn by stretch8(). Loop holes sit at y = -80 and 80.
function eightMark(cls = 'eight') {
  const id = 'sl8-eight-' + markSeq++;
  const box = 'x="-140" y="-240" width="280" height="480"';
  const mask = (n, d) => `<mask id="${id}${n}" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="#fff"/><path d="${d}" fill="none" stroke="#000" stroke-width="8"/></mask>`;
  const ring = (n, cy) => `<g class="loop loop-${n}"><circle cy="${cy}" r="81.5" fill="none" stroke="currentColor" stroke-width="48" mask="url(#${id}${n})"/></g>`;
  return `<svg class="${cls}" viewBox="-112 -195 224 390" aria-hidden="true" overflow="visible"><defs>${mask('t', 'M-100.1 33.3A110.5 110.5 0 0 1 -15.4 -29.4')}${mask('b', 'M100.1 -33.3A110.5 110.5 0 0 1 15.4 29.4')}</defs><g class="strands" fill="none" stroke="currentColor" stroke-linecap="butt"><path class="strand"/><path class="strand"/></g>${ring('t', -80)}${ring('b', 80)}</svg>`;
}
// Pull the 8's loops apart by u units each way; the crossing strands stretch and thin like a band.
function stretch8(svg, u) {
  svg.querySelector('.loop-t').style.transform = `translateY(${-u}px)`;
  svg.querySelector('.loop-b').style.transform = `translateY(${u}px)`;
  const strands = svg.querySelectorAll('.strand'), r = 81.5;
  svg.querySelectorAll('mask path').forEach((p) => p.setAttribute('stroke-width', Math.max(0, Math.min(8, 8 - u)))); // the crossing cuts close as the loops part
  if (u < 1) { strands.forEach((p) => p.setAttribute('d', '')); return; }
  const ty = -80 - u, by = 80 + u, s = Math.sin(Math.PI / 3) * r, c = r / 2, k = (by - ty) * 0.35;
  const width = 48 * Math.sqrt(160 / (160 + 2 * u)); // stretching thins the band
  [[-c, c], [c, -c]].forEach(([x1, x2], i) => {
    strands[i].setAttribute('d', `M${x1} ${ty + s}C${x1} ${ty + s + k} ${x2} ${by - s - k} ${x2} ${by - s}`);
    strands[i].setAttribute('stroke-width', width.toFixed(1));
  });
}
// <span data-mark></span> placeholders become the mark (used in the "Think" + mark wordmark)
for (const el of document.querySelectorAll('[data-mark]')) el.innerHTML = sl8Mark('mark', el.dataset.mark || 'SL8');

// Messages for the ?ai= / ?ai_error= parameters the AI sign-in returns with
const AI_RETURN = {
  connected: 'Your AI is connected.',
  cancelled: 'Connection cancelled. Nothing was changed.',
  denied: "OpenRouter didn't approve the connection. Try again, or use an API key in Settings.",
  exchange: "OpenRouter's sign-in didn't finish. Try connecting again.",
  check: "You signed in, but OpenRouter couldn't run models for this account yet. Try again in a minute, or use an API key in Settings.",
  expired: 'That sign-in took too long or was already used. Start it again.',
};
function aiReturnMessage() {
  const q = new URLSearchParams(location.search);
  const msg = q.get('ai') === 'connected' ? AI_RETURN.connected : AI_RETURN[q.get('ai_error')];
  if (!msg) return null;
  q.delete('ai');
  q.delete('ai_error');
  history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '') + location.hash);
  return msg;
}
