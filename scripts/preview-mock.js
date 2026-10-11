// Stand-in for the ThinkSL8 server, used only by the preview artifact (scripts/build-preview.py).
// Canvases are kept in this browser's storage; uploaded images last until the page reloads; AI is off.
(() => {
  const KEY = 'thinksl8-preview-v1';
  const now = Date.now();
  const uid = () => crypto.randomUUID();
  const text = (x, y, s, c, t, w = 320) => ({ id: uid(), kind: 'text', t: now, x, y, w, s, c, text: t });
  const wave = (x, y, len, amp, pt, c, w, pr) => {
    const p = [];
    for (let i = 0; i <= 40; i++) p.push(x + (len * i) / 40, Math.round((y + Math.sin(i / 4) * amp) * 10) / 10, pr ? Math.round((0.35 + 0.5 * Math.sin((i / 40) * Math.PI)) * 100) / 100 : 0.5);
    return { id: uid(), kind: 'stroke', t: now, c, w, pr, p, ...(pt ? { pt } : {}) };
  };

  function seed() {
    const home = uid(), inner = uid();
    const title = text(0, 0, 34, 'ink', 'ThinkSL8 launch', 420);
    const who = text(0, 100, 18, 'ink', 'Who is it for? Students, and anyone who thinks in pictures.');
    const price = text(470, 100, 18, 'blue', 'Pricing: free to start, Pro later.');
    const feel = text(0, 250, 18, 'ink', 'It should feel like paper, not software.');
    const next = text(470, 250, 18, 'green', 'Next: sharing a canvas with a friend.');
    const conn = (a, b, label) => ({ id: uid(), kind: 'conn', t: now, a: a.id, b: b.id, c: 'ink', ...(label ? { label } : {}) });
    const pens = [['', 'Pen', 'ink', 3, true], ['pencil', 'Pencil', 'ink', 4, false], ['marker', 'Marker', 'red', 8, false], ['brush', 'Brush', 'purple', 6, true], ['nib', 'Calligraphy nib', 'teal', 8, false]];
    const strokes = [], labels = [];
    pens.forEach(([pt, label, c, w, pr], i) => {
      strokes.push(wave(0, 430 + i * 64, 260, 12, pt, c, w, pr));
      labels.push(text(290, 414 + i * 64, 15, 'ink', label, 200));
    });
    const hl = { id: uid(), kind: 'stroke', t: now, c: 'yellow', w: 22, hl: true, pr: false, p: [470, 113, 0.5, 700, 113, 0.5] };
    const portal = { id: uid(), kind: 'portal', t: now, x: 900, y: 90, w: 240, h: 132, target: inner };
    const items = [title, who, price, feel, next, conn(title, who), conn(title, price, 'costs'), conn(who, feel), conn(price, next), hl, ...strokes, ...labels, portal];
    const a = text(0, 0, 30, 'ink', 'Pricing details', 400), b = text(0, 90, 18, 'ink', 'Free: everything you need to think.'), c = text(440, 90, 18, 'ink', 'Pro: sharing, more storage.');
    return {
      home,
      notes: {
        [home]: { id: home, title: 'Product ideas', updated_at: now, style: {}, items: Object.fromEntries(items.map((i) => [i.id, i])) },
        [inner]: { id: inner, title: 'Pricing details', updated_at: now, style: { theme: 'blueprint', pattern: 'graph' }, items: Object.fromEntries([a, b, c, conn(b, c, 'upgrade')].map((i) => [i.id, i])) },
      },
    };
  }

  let db = store.get(KEY);
  if (!db?.notes?.[db.home]) db = seed();
  const save = () => store.set(KEY, db);
  save();
  const files = new Map();
  const fail = (status, msg) => Object.assign(new Error(msg), { status });

  window.previewNoteId = () => { try { return sessionStorage.getItem('preview:note') || db.home; } catch { return db.home; } };
  window.previewReset = () => { store.set(KEY, null); store.set('sl8:tearSound', null); store.set('sl8:logo', null); try { sessionStorage.removeItem('preview:note'); } catch {} location.reload(); };
  // stands in for Settings > Logo colours
  window.previewLogo = () => { store.set('sl8:logo', { bg: document.getElementById('pv-bg').value, fg: document.getElementById('pv-fg').value }); applyLogo(); };
  // stands in for Settings > Tear sound
  window.previewSound = async (input) => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    try { await tearFile.set(f); } catch { return toast("This browser couldn't keep the sound."); }
    store.set('sl8:tearSound', 'own');
    toast(`Tear sound: ${f.name}. Tap Replay to hear it.`);
  };
  fileUrl = (id) => files.get(id) || '';
  go = (href) => {
    const id = new URL(href, 'https://x').searchParams.get('id');
    if (href.startsWith('/note') && id && db.notes[id]) {
      try { sessionStorage.setItem('preview:note', id); } catch {}
      location.reload();
    } else toast('That page is part of the full app, not this preview.');
  };
  // first visit in this tab plays the opening
  try { if (!sessionStorage.getItem('preview:started')) { sessionStorage.setItem('preview:started', '1'); sessionStorage.setItem('sl8:reveal', '1'); } } catch {}
  // start zoomed out on phones so more of the sample canvas is in view
  for (const id of Object.keys(db.notes)) if (!store.get('sl8:cam:' + id)) store.set('sl8:cam:' + id, innerWidth < 640 ? { x: 20, y: 120, z: 0.55 } : { x: 60, y: 110, z: 0.9 });

  api = async (path, { method = 'GET', body } = {}) => {
    const u = new URL(path, 'https://x'), p = u.pathname;
    if (p === '/api/notes' && method === 'GET') return { notes: Object.values(db.notes).map(({ id, title, updated_at }) => ({ id, title, updated_at })) };
    if (p === '/api/notes' && method === 'POST') {
      const note = { id: uid(), title: String(body?.title || 'Untitled').slice(0, 200), updated_at: Date.now(), style: body?.style || {}, items: {} };
      db.notes[note.id] = note;
      save();
      return { note: { id: note.id, title: note.title, updated_at: note.updated_at } };
    }
    const m = p.match(/^\/api\/notes\/([\w-]+)(\/ops)?$/);
    if (m) {
      const n = db.notes[m[1]];
      if (!n) throw fail(404, 'Canvas not found.');
      if (m[2]) {
        for (const op of body.ops) op.put ? (n.items[op.put.id] = op.put) : delete n.items[op.del];
        n.updated_at = Date.now();
        save();
        return { ok: true };
      }
      if (method === 'GET') return { note: { id: n.id, title: n.title, updated_at: n.updated_at, style: n.style }, items: Object.values(n.items) };
      if (method === 'PATCH') {
        if (body.title !== undefined) n.title = String(body.title).trim().slice(0, 200) || 'Untitled';
        if (body.style !== undefined) n.style = body.style;
        save();
        return { title: n.title, style: n.style };
      }
    }
    if (p === '/api/ai') return { available: false, connection: null, providers: [] };
    throw fail(404, 'Not part of the preview.');
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    if (url === '/api/files' && opts.method === 'POST') {
      const id = uid();
      files.set(id, URL.createObjectURL(opts.body));
      return new Response(JSON.stringify({ id }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  // links to the app's other pages stay inside the preview
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="/"]');
    if (a) { e.preventDefault(); go(a.getAttribute('href')); }
  }, true);
})();
