const $ = (s) => document.querySelector(s);
let mode = 'login';

function setMode(m) {
  mode = m;
  $('#tab-login').setAttribute('aria-selected', String(m === 'login'));
  $('#tab-signup').setAttribute('aria-selected', String(m === 'signup'));
  $('#submit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('#password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('#pw-hint').hidden = m === 'login';
  $('#forgot').hidden = m !== 'login';
  $('#consent').hidden = m === 'login';
  $('#error').hidden = true;
}
$('#tab-login').onclick = () => setMode('login');
$('#tab-signup').onclick = () => setMode('signup');

// Signed in: go to setup the first time, otherwise straight into the canvas you used last.
async function enter() {
  const me = await api('/api/me');
  if (!me.onboarded) return location.replace('/welcome');
  const id = me.lastNoteId || (await api('/api/notes', { method: 'POST', body: { title: 'Untitled' } })).note.id;
  try { sessionStorage.setItem('sl8:reveal', '1'); } catch {}
  location.replace('/note?id=' + encodeURIComponent(id));
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#submit');
  btn.disabled = true;
  $('#error').hidden = true;
  try {
    await api(mode === 'login' ? '/api/login' : '/api/signup', {
      method: 'POST', body: { email: $('#email').value, password: $('#password').value, turnstile: botToken() },
    });
    $('#password').value = '';
    await enter();
  } catch (err) {
    $('#error').textContent = err.message;
    $('#error').hidden = false;
    btn.disabled = false;
  }
});

let botToken = () => undefined;
botCheck($('#bot')).then((f) => (botToken = f));

enter().catch((err) => {
  $('#entering').hidden = true;
  $('#auth').hidden = false;
  $('#foot').hidden = false;
  if (new URLSearchParams(location.search).has('deleted')) toast('Your account and everything in it has been deleted.');
  if (err.status !== 401) toast(err.message);
});
