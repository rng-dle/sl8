const $ = (s) => document.querySelector(s);
try { sessionStorage.removeItem('sl8:trail'); } catch {} // portals' way back starts fresh from here
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ms) {
  const s = (ms - Date.now()) / 1000;
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  }
  return 'just now';
}

let current = [];
function render() {
  $('#loading').hidden = true;
  $('#count').textContent = current.length ? String(current.length) : '';
  $('#empty').hidden = current.length > 0;
  $('#notes').replaceChildren(...current.map((n) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/note?id=' + encodeURIComponent(n.id);
    const t = document.createElement('span'); t.className = 't'; t.textContent = n.title;
    const d = document.createElement('span'); d.className = 'd'; d.textContent = 'Edited ' + ago(n.updated_at);
    a.append(t, d);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn del';
    del.setAttribute('aria-label', 'Delete ' + n.title);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    let timer;
    del.onclick = async () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = 'Delete canvas';
        timer = setTimeout(render, 4000);
        return;
      }
      clearTimeout(timer);
      del.disabled = true;
      try {
        await api('/api/notes/' + encodeURIComponent(n.id), { method: 'DELETE' });
        current = current.filter((x) => x.id !== n.id);
      } catch (err) {
        toast(err.message);
      }
      render();
    };
    li.append(a, del);
    return li;
  }));
}

$('#new').onclick = async () => {
  $('#new').disabled = true;
  try {
    const { note } = await api('/api/notes', { method: 'POST', body: { title: 'Untitled' } });
    location.href = '/note?id=' + encodeURIComponent(note.id);
  } catch (err) {
    toast(err.message);
    $('#new').disabled = false;
  }
};

// search: snippets arrive with \u0001 / \u0002 around matches, turned into <mark> as text nodes
function snippetNodes(s) {
  return s.split(/(\u0001[^\u0002]*\u0002)/).map((part) => {
    if (!part.startsWith('\u0001')) return document.createTextNode(part);
    const m = document.createElement('mark');
    m.textContent = part.slice(1, -1);
    return m;
  });
}
function resultItem(href, title, sub, snippet) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = href;
  if (snippet) { const s = document.createElement('span'); s.className = 's'; s.append(...snippetNodes(snippet)); a.append(s); }
  const t = document.createElement('span'); t.className = snippet ? 'd' : 't'; t.textContent = title;
  const d = document.createElement('span'); d.className = 'd'; d.textContent = sub;
  a.append(t);
  if (sub) a.append(d);
  li.append(a);
  return li;
}
let searchTimer, searchSeq = 0;
$('#search-form').addEventListener('submit', (e) => e.preventDefault());
$('#q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 220);
});
async function search() {
  const q = $('#q').value.trim();
  const listing = !q;
  $('#notes').hidden = !listing;
  $('#empty').hidden = !listing || current.length > 0;
  $('#found').hidden = listing;
  if (listing) return;
  const seq = ++searchSeq;
  try {
    const { results, canvases } = await api('/api/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return; // a newer search is on its way
    const n = results.length + canvases.length;
    $('#found-count').textContent = n ? `${n} result${n === 1 ? '' : 's'}` : 'Nothing found. Search looks at typed text and canvas titles, not handwriting.';
    $('#results').replaceChildren(
      ...canvases.map((c) => resultItem('/note?id=' + encodeURIComponent(c.id), c.title, 'Canvas · edited ' + ago(c.updated_at))),
      ...results.map((r) => resultItem(`/note?id=${encodeURIComponent(r.noteId)}#item-${r.id}`, `In “${r.title}” · ${ago(r.updated)}`, '', r.snippet)),
    );
  } catch (err) {
    toast(err.message);
  }
}

addEventListener('pageshow', (e) => e.persisted && load());
async function load() {
  try {
    current = (await api('/api/notes')).notes;
    render();
  } catch (err) {
    if (err.status === 401) return location.replace('/');
    toast(err.message);
  }
}
load();
