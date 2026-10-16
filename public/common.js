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

// The bot check (Cloudflare Turnstile), when the server has it switched on. botCheck(el) shows it inside el and
// gives back a function that returns the current token (and readies a fresh one: each token works once).
async function botCheck(el) {
  const { botCheck: sitekey } = await api('/api/config').catch(() => ({}));
  if (!sitekey) return () => undefined;
  await new Promise((ok) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = ok;
    s.onerror = () => { toast("The bot check couldn't load. Check your connection and reload."); ok(); };
    document.head.append(s);
  });
  if (!window.turnstile) return () => undefined;
  const id = turnstile.render(el, { sitekey, theme: 'auto', size: 'flexible' });
  return () => { const t = turnstile.getResponse(id); turnstile.reset(id); return t; };
}

// Android app + pen: inside the Android app, on a device where a pen has been used, ask once whether pulling the pen out
// should open ThinkSL8. "Set it up" hands off to the app (/app/pen-setup), which shows Android's one-tap notes-app prompt.
// The answer is kept per device in sl8:penask. (Samsung's own "When S Pen is removed" switch can't be changed by an app.)
if (new URLSearchParams(location.search).get('src') === 'app' || document.referrer.startsWith('android-app://com.thinksl8.app')) store.set('sl8:app', 1);
addEventListener('pointerdown', (e) => { if (e.pointerType === 'pen') store.set('sl8:pen', 1); }, { capture: true, passive: true });
function penAsk() {
  const bar = (html) => {
    let el = document.getElementById('pen-ask');
    if (!el) { el = document.createElement('div'); el.id = 'pen-ask'; el.className = 'pen-ask'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Pen setup'); document.body.append(el); }
    el.innerHTML = html;
    return el;
  };
  const q = new URLSearchParams(location.search), result = q.get('pen');
  if (result) {
    q.delete('pen');
    history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '') + location.hash);
    if (result === 'held') {
      bar('<div><b>ThinkSL8 is your notes app</b><p>One switch is left, and only Samsung can flip it: Settings → Advanced features → S Pen → When S Pen is removed → Create note.</p></div><div class="row"><button class="btn primary" id="pen-ok">Got it</button></div>')
        .querySelector('#pen-ok').onclick = () => { store.set('sl8:penask', 'done'); document.getElementById('pen-ask').remove(); };
    } else {
      store.set('sl8:penask', 'no');
      toast(result === 'declined' ? 'No change made. ThinkSL8 is not your notes app.' : "This version of Android doesn't let an app become the notes app. You can still add ThinkSL8 to your pen's Air command menu.");
    }
    return;
  }
  if (!/Android/i.test(navigator.userAgent) || !store.get('sl8:app') || !store.get('sl8:pen') || ['no', 'done'].includes(store.get('sl8:penask'))) return;
  const el = bar('<div><b>Open ThinkSL8 when you pull out your pen?</b><p>Android will ask you to confirm once. You can change it any time in Android settings.</p></div><div class="row"><button class="btn quiet" id="pen-no">Not now</button><button class="btn primary" id="pen-yes">Set it up</button></div>');
  el.querySelector('#pen-no').onclick = () => { store.set('sl8:penask', 'no'); el.remove(); };
  // An intent: link launches the app's own screen; a normal link to our own site would just stay in the app's browser window.
  el.querySelector('#pen-yes').onclick = () => go('intent://pen-setup#Intent;scheme=thinksl8;package=com.thinksl8.app;S.browser_fallback_url=' + encodeURIComponent(location.origin + '/app/pen-setup') + ';end');
}
