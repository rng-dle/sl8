const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('token');
if (token) history.replaceState(null, '', '/reset'); // keep the token out of history and screenshots
$(token ? '#set' : '#ask').hidden = false;

let botToken = () => undefined;
if (!token) botCheck($('#bot')).then((f) => (botToken = f));

function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

$('#ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#ask-btn');
  busy(btn, true, 'Sending…');
  $('#ask-error').hidden = true;
  try {
    await api('/api/password/forgot', { method: 'POST', body: { email: $('#email').value, turnstile: botToken() } });
    $('#asked-email').textContent = $('#email').value.trim();
    $('#ask').hidden = true;
    $('#asked').hidden = false;
  } catch (err) {
    $('#ask-error').textContent = err.message;
    $('#ask-error').hidden = false;
  } finally {
    busy(btn, false, 'Send reset link');
  }
});

$('#set-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#set-btn');
  busy(btn, true, 'Saving…');
  $('#set-error').hidden = true;
  try {
    await api('/api/password/reset', { method: 'POST', body: { token, password: $('#password').value } });
    location.replace('/');
  } catch (err) {
    $('#set-error').replaceChildren(err.message);
    if (/expired|used/.test(err.message)) {
      const a = document.createElement('a');
      a.href = '/reset';
      a.textContent = ' Send a new link';
      $('#set-error').append(a);
    }
    $('#set-error').hidden = false;
    busy(btn, false, 'Save password and sign in');
  }
});
