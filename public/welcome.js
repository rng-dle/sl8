const $ = (s) => document.querySelector(s);
let start = 'blank', aiAvailable = false;

// Create the first canvas, mark setup done, then either sign in to the AI provider or open the canvas.
async function finish(connect) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try {
    const { note } = await api('/api/notes', { method: 'POST', body: start === 'sample' ? { sample: true } : { title: 'Untitled' } });
    await api('/api/me/onboarded', { method: 'POST' });
    try { sessionStorage.setItem('sl8:reveal', '1'); if (start === 'tour') sessionStorage.setItem('sl8:tour', '1'); } catch {}
    const canvas = '/note?id=' + encodeURIComponent(note.id);
    location.replace(connect ? '/api/ai/openrouter/start?return=' + encodeURIComponent(canvas) : canvas);
  } catch (e) {
    if (e.status === 401) return location.replace('/');
    $('#error').textContent = e.message;
    $('#error').hidden = false;
    for (const b of document.querySelectorAll('button')) b.disabled = false;
  }
}

for (const b of document.querySelectorAll('[data-start]')) {
  b.onclick = () => {
    start = b.dataset.start;
    if (!aiAvailable) return finish(false);
    $('#s1').hidden = true;
    $('#s2').hidden = false;
    $('#connect').focus();
  };
}
$('#skip-all').onclick = () => finish(false);
$('#later').onclick = () => finish(false);
$('#connect').onclick = () => { $('#connect').textContent = 'Opening OpenRouter…'; finish(true); };

api('/api/me').then(async (me) => {
  if (me.onboarded) return location.replace('/');
  aiAvailable = (await api('/api/ai')).available;
  if (!aiAvailable) $('.step-label').textContent = 'Getting started';
}).catch((e) => e.status === 401 && location.replace('/'));
