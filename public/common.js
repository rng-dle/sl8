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

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// Bernoulli lemniscate, starting at its crossing point so a drawn stroke begins in the middle
function infinityPath(cx, cy, a, steps = 120) {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = Math.PI / 2 + (i / steps) * Math.PI * 2, s = Math.sin(t), c = Math.cos(t), k = 1 + s * s;
    d += (i ? 'L' : 'M') + (cx + (a * c) / k).toFixed(2) + ' ' + (cy + (a * s * c) / k).toFixed(2);
  }
  return d;
}

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
