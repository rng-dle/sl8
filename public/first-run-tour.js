// First-run tour for new accounts and guests, made with driver.js (vendored in /vendor, MIT, built from the official source).
// It drives the real toolbar: in the ring layout it opens the ring for the tool steps and folds it away afterwards.
// If driver.js can't load, the built-in interactive tour in note.js runs instead.
(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const load = () => new Promise((ok, no) => {
    if (window.driver?.js) return ok();
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/driver.css' });
    const js = Object.assign(document.createElement('script'), { src: '/vendor/driver.js', onload: ok, onerror: no });
    document.head.append(css, js);
  });
  const shown = (sel) => { const el = document.querySelector(sel); return el && el.getBoundingClientRect().width ? el : null; };
  // note.js owns the ring: ringOn() says whether this device uses it, openRing() opens and folds it
  const ring = () => typeof ringOn === 'function' && ringOn();
  const setRing = async (on) => { if (ring() && ringOpen() !== on) { openRing(on); await wait(420); } }; // 420ms: the ring's own animation

  window.firstRunTour = async (fallback) => {
    let d;
    try {
      await load();
      while (document.querySelector('.reveal')) await wait(300); // let the opening finish
      const touch = matchMedia('(pointer: coarse)').matches;
      const tool = (name) => () => shown(`[data-tool="${name}"]`);
      const tools = () => shown('#fab') || shown('nav.bar');
      // inRing: the step shows a tool, so the ring is open for it (it does nothing on the bar layout)
      const raw = [
        { popover: { title: 'Welcome to ThinkSL8', description: touch ? 'This canvas never ends. Move with two fingers, pinch to zoom.' : 'This canvas never ends. Scroll to move, Ctrl + scroll to zoom.' } },
        { element: tools, popover: { title: 'Your tools', description: ring() ? 'Everything lives behind this button. Tap it any time. You can drag it anywhere. Next, we\'ll open it.' : 'Your tools live in this bar.', side: 'top' } },
        { element: tool('pen'), inRing: true, popover: { title: 'Pen', description: 'Handwrite or sketch anywhere. With a stylus, pressure shapes the line.', side: 'top' } },
        { element: tool('text'), inRing: true, popover: { title: 'Text', description: `Pick it, then ${touch ? 'tap' : 'click'} anywhere and type. No folders, no titles.`, side: 'top' } },
        { element: tool('connect'), inRing: true, popover: { title: 'Arrows', description: 'Drag from one note to another to link them.', side: 'top' } },
        { element: () => shown('#ai-open'), popover: { title: 'Ask AI', description: 'Ask about what you wrote, with links back to the notes used. Needs a free account.', side: 'bottom' } },
        { element: () => shown('#menu-open'), popover: { title: 'Menu', description: 'Themes, backgrounds, portals, sharing, and this tour again.', side: 'bottom' } },
      ];
      const steps = raw.map((s) => ({
        ...s,
        onHighlightStarted: async () => { // set the ring first, then re-measure, so the highlight lands on the real button
          if (s.inRing && ring() && !ringOpen()) { await setRing(true); d.refresh(); }
          else if (!s.inRing && ring() && ringOpen()) { await setRing(false); d.refresh(); }
        },
      }));
      d = window.driver.js.driver({
        showProgress: true, allowClose: true, overlayOpacity: 0.55, smoothScroll: false, steps,
        onDestroyed: () => { setRing(false); },
      });
      d.drive();
    } catch { fallback?.(); }
  };
})();
