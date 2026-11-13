// First-run tour for new accounts and guests, made with driver.js (loaded from the CDN only when a tour starts).
// If driver.js can't load (offline, blocked), the built-in interactive tour in note.js runs instead.
// TODO: pin driver.js to an exact version and add an integrity hash, or copy dist/ into public/.
(() => {
  const BASE = 'https://cdn.jsdelivr.net/npm/driver.js@1/dist/';
  const load = () => new Promise((ok, no) => {
    if (window.driver?.js) return ok();
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: BASE + 'driver.css' });
    const js = Object.assign(document.createElement('script'), { src: BASE + 'driver.js.iife.js', onload: ok, onerror: no });
    document.head.append(css, js);
    setTimeout(no, 8000);
  });
  const shown = (sel) => { const el = document.querySelector(sel); return el && el.getBoundingClientRect().width ? el : null; };

  window.firstRunTour = async (fallback) => {
    try {
      await load();
      while (document.querySelector('.reveal')) await new Promise((r) => setTimeout(r, 300)); // let the opening finish
      const touch = matchMedia('(pointer: coarse)').matches;
      const tools = () => shown('#fab') || shown('nav.bar'); // the ring button, or the bar
      const steps = [
        { popover: { title: 'Welcome to ThinkSL8', description: touch ? 'This canvas never ends. Move with two fingers, pinch to zoom.' : 'This canvas never ends. Scroll to move, Ctrl + scroll to zoom.' } },
        { element: tools, popover: { title: 'Your tools', description: 'Pen, text, arrows, shapes and more live here. Pick one, then use the canvas.', side: 'top' } },
        { element: () => shown('[data-tool="pen"]') || tools(), popover: { title: 'Pen', description: 'Handwrite or sketch anywhere. With a stylus, pressure shapes the line.', side: 'top' } },
        { element: () => shown('[data-tool="text"]') || tools(), popover: { title: 'Text', description: `${touch ? 'Tap' : 'Click'} anywhere and type. No folders, no titles.`, side: 'top' } },
        { element: () => shown('[data-tool="connect"]') || tools(), popover: { title: 'Arrows', description: 'Drag from one note to another to link them.', side: 'top' } },
        { element: () => shown('#ai-open'), popover: { title: 'Ask AI', description: 'Ask about what you wrote, with links back to the notes used. Needs a free account.', side: 'bottom' } },
        { element: () => shown('#menu-open'), popover: { title: 'Menu', description: 'Themes, backgrounds, portals, sharing, and this tour again.', side: 'bottom' } },
      ].filter((s) => !s.element || s.element());
      const d = window.driver.js.driver({ showProgress: true, allowClose: true, overlayOpacity: 0.55, smoothScroll: false, steps });
      d.drive();
    } catch { fallback?.(); }
  };
})();
