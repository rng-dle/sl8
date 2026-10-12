// The link from the confirmation email. It only confirms when the page runs, so mail scanners that open links don't.
const token = new URLSearchParams(location.search).get('token');
history.replaceState(null, '', '/verify'); // keep the token out of history and screenshots
api('/api/verify', { method: 'POST', body: { token } }).then(() => {
  document.querySelector('#head').textContent = 'Email confirmed';
  document.querySelector('#msg').textContent = 'Thanks. You can share canvases now.';
}, (err) => {
  document.querySelector('#head').textContent = "That link didn't work";
  document.querySelector('#msg').textContent = err.message;
});
