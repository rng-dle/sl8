const $ = (s) => document.querySelector(s);
const SCOPE_TEXT = { selection: 'the notes you select', canvas: 'the canvas you ask from', all: 'any of your canvases' };
let state = null, providers = [];

function show(id) {
  for (const s of ['#ai-loading', '#ai-off', '#ai-on', '#ai-unavailable']) $(s).hidden = s !== id;
}

async function loadAI() {
  try {
    const r = await api('/api/ai');
    providers = r.providers;
    $('#provider').replaceChildren(...providers.map((p) => new Option(p.id === 'anthropic' ? 'Anthropic (Claude)' : p.label, p.id)));
    $('#provider').value = 'openai';
    updateKeysUrl();
    if (!r.available) { show('#ai-unavailable'); $('#advanced').hidden = true; return; }
    $('#advanced').hidden = false;
    render(r.connection);
  } catch (e) {
    if (e.status === 401) return location.replace('/');
    $('#ai-loading').textContent = e.message;
  }
}

function render(conn) {
  state = conn;
  if (!conn) { show('#ai-off'); return; }
  show('#ai-on');
  $('#ai-on').style.display = 'grid';
  $('#ai-name').textContent = `Connected to ${conn.label}`;
  $('#ai-how').textContent = (conn.method === 'oauth' ? `Signed in with ${conn.label}` : 'API key') + ` · key ending ${conn.hint}`;
  const needs = conn.status === 'reconnect';
  $('#ai-dot').classList.toggle('warn', needs);
  $('#ai-reconnect').hidden = !needs;
  if (needs) {
    $('#ai-reconnect').replaceChildren(`${conn.label} stopped accepting this connection. It may have been revoked or expired. `);
    const a = document.createElement('a');
    a.textContent = conn.method === 'oauth' ? 'Reconnect with OpenRouter' : 'Enter a new key';
    a.href = conn.method === 'oauth' ? orStart() : '#advanced';
    if (conn.method !== 'oauth') a.onclick = () => { $('#advanced').open = true; $('#provider').value = conn.provider; updateKeysUrl(); $('#key').focus(); };
    $('#ai-reconnect').append(a);
  }
  for (const r of document.querySelectorAll('input[name=scope]')) r.checked = r.value === conn.scope;
  $('#disclosure').textContent = `When you ask something, ThinkSL8 sends your question and the typed text from ${SCOPE_TEXT[conn.scope]} to ${conn.label} so it can answer. Handwriting and drawings go as a picture (for all canvases, only from the canvas you have open). Nothing is sent in the background. ${conn.label}'s own terms apply to what it receives.`;
  loadModels();
}

async function loadModels() {
  const sel = $('#model');
  sel.disabled = true;
  sel.replaceChildren(new Option('Loading models…', ''));
  $('#model-help').textContent = '';
  try {
    const { models } = await api('/api/ai/models');
    const opts = [];
    if (state.provider === 'openrouter') opts.push(new Option('Auto (OpenRouter picks a paid model)', 'openrouter/auto'));
    for (const m of models) opts.push(new Option(m.free ? `${m.name} · free` : m.name, m.id));
    if (!opts.some((o) => o.value === state.model)) opts.unshift(new Option(state.model, state.model));
    sel.replaceChildren(...opts);
    sel.value = state.model;
    sel.disabled = false;
    $('#model-help').textContent = state.provider === 'openrouter' ? 'Models marked free cost nothing but are limited to 50 requests a day until you add credits on OpenRouter.' : '';
  } catch (e) {
    sel.replaceChildren(new Option(state.model, state.model));
    $('#model-help').textContent = e.message;
    if (e.kind === 'auth') loadAI();
  }
}

async function patch(body) {
  try {
    render((await api('/api/ai', { method: 'PATCH', body })).connection);
    toast('Saved.');
  } catch (e) { toast(e.message); }
}
$('#model').onchange = () => patch({ model: $('#model').value });
for (const r of document.querySelectorAll('input[name=scope]')) r.onchange = () => patch({ scope: r.value });

let disarm;
$('#disconnect').onclick = async () => {
  const b = $('#disconnect');
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = `Yes, disconnect ${state.label}`;
    disarm = setTimeout(() => { delete b.dataset.armed; b.textContent = 'Disconnect'; }, 5000);
    return;
  }
  clearTimeout(disarm);
  const was = state;
  try {
    await api('/api/ai', { method: 'DELETE' });
    delete b.dataset.armed;
    b.textContent = 'Disconnect';
    render(null);
    toast(`Disconnected. ThinkSL8 no longer has the key. To revoke it on ${was.label} as well, delete it at ${was.keysUrl}`);
  } catch (e) { toast(e.message); }
};

function orStart() {
  return '/api/ai/openrouter/start?return=' + encodeURIComponent('/settings');
}
$('#or-connect').addEventListener('click', (e) => {
  e.preventDefault();
  $('#or-connect').textContent = 'Opening OpenRouter…';
  $('#or-connect').setAttribute('aria-disabled', 'true');
  location.href = orStart();
});

function updateKeysUrl() {
  $('#keys-url').textContent = providers.find((p) => p.id === $('#provider').value)?.keysUrl || '';
}
$('#provider').onchange = updateKeysUrl;
$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#key-submit');
  btn.disabled = true;
  btn.textContent = 'Checking the key…';
  $('#key-error').hidden = true;
  try {
    const r = await api('/api/ai/key', { method: 'POST', body: { provider: $('#provider').value, key: $('#key').value } });
    $('#key').value = '';
    $('#advanced').open = false;
    render(r.connection);
    toast(`Connected to ${r.connection.label}.`);
  } catch (err) {
    $('#key-error').textContent = err.message;
    $('#key-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check and connect';
  }
});

// appearance (this device)
function bindPref(name, key, fallback, apply) {
  const v = store.get(key) ?? fallback;
  for (const r of document.querySelectorAll(`input[name=${name}]`)) {
    r.checked = r.value === v;
    r.onchange = () => { store.set(key, r.value || null); apply?.(r.value); };
  }
}
bindPref('theme', 'sl8:theme', '', applyTheme);
bindPref('bg', 'sl8:bg', 'dots');
bindPref('reveal', 'sl8:revealMode', 'full');
bindPref('toolbar', 'sl8:toolbar', 'ring');

// logo colours (this device): applied as you pick
$('#logo-preview').innerHTML = sl8Mark();
function showLogo() {
  const c = store.get('sl8:logo') || LOGO;
  $('#logo-bg').value = c.bg;
  $('#logo-fg').value = c.fg;
  $('#logo-reset').hidden = !store.get('sl8:logo');
  applyLogo();
}
for (const id of ['#logo-bg', '#logo-fg']) {
  $(id).addEventListener('input', () => { store.set('sl8:logo', { bg: $('#logo-bg').value, fg: $('#logo-fg').value }); showLogo(); });
}
$('#logo-reset').onclick = () => { store.set('sl8:logo', null); showLogo(); };
showLogo();

// tear sound (this device): the built-in rip, the user's own audio file, or nothing
let playTear = tearSoundPlayer();
const tearUi = (v = store.get('sl8:tearSound') ?? 'rip') => {
  $('#tear-own').hidden = v !== 'own';
  $('#tear-play').hidden = v === 'off';
  playTear = tearSoundPlayer();
};
let hasTearFile = false;
bindPref('tear', 'sl8:tearSound', 'rip', (v) => { tearUi(v); if (v === 'own' && !hasTearFile) $('#tear-file').click(); });
tearUi();
tearFile.get().then((f) => { if (f) { hasTearFile = true; $('#tear-name').textContent = f.name; } });
$('#tear-play').onclick = () => playTear();
$('#tear-file').onchange = async () => {
  const f = $('#tear-file').files[0];
  $('#tear-file').value = '';
  if (!f) return;
  if (f.size > 10e6) return toast('Choose a sound under 10 MB.');
  const audio = new Audio(URL.createObjectURL(f));
  try { await audio.play(); } catch { return toast("That file can't be played as a sound here. Try an MP3."); }
  setTimeout(() => audio.pause(), TEAR_MAX_MS);
  try {
    await tearFile.set(f);
    hasTearFile = true;
    $('#tear-name').textContent = f.name;
    playTear = tearSoundPlayer();
  } catch { toast("This browser couldn't keep the sound. It may be in private mode."); }
};

$('#logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  location.replace('/');
};
$('#logout-all').onclick = async () => {
  try {
    await api('/api/logout-all', { method: 'POST' });
    location.replace('/');
  } catch (e) { toast(e.message); }
};

$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#pw-btn');
  btn.disabled = true;
  $('#pw-error').hidden = true;
  try {
    await api('/api/password/change', { method: 'POST', body: { current: $('#pw-current').value, password: $('#pw-new').value } });
    $('#pw-form').reset();
    $('#pw-form').closest('details').open = false;
    toast('Password changed. Other devices have been signed out.');
  } catch (err) {
    $('#pw-error').textContent = err.message;
    $('#pw-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#del-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#del-btn');
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Yes, delete everything permanently';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete my account'; }, 6000);
    return;
  }
  btn.disabled = true;
  $('#del-error').hidden = true;
  try {
    await api('/api/account/delete', { method: 'POST', body: { password: $('#del-pw').value } });
    try { localStorage.clear(); } catch {}
    location.replace('/?deleted=1');
  } catch (err) {
    $('#del-error').textContent = err.message;
    $('#del-error').hidden = false;
    btn.disabled = false;
  }
});

api('/api/me').then((me) => {
  $('#email').textContent = me.email;
  if (me.lastNoteId) $('#back').href = '/note?id=' + encodeURIComponent(me.lastNoteId);
}).catch((e) => e.status === 401 && location.replace('/'));
const msg = aiReturnMessage();
if (msg) toast(msg);
loadAI();
