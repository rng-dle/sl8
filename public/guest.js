// Guest demo pill: shown only to guest sessions. Says how long the demo lasts and links to "keep my canvases" (sign-up).
(async () => {
  try {
    const me = await api('/api/me');
    if (!me.guest) return;
    const left = Math.max(1, Math.round((me.guestUntil - Date.now()) / 36e5));
    const bar = document.createElement('a');
    bar.href = '/?upgrade=1';
    bar.textContent = `Guest demo · wiped in ~${left}h · Save your work`;
    bar.style.cssText = 'position:fixed;z-index:11;right:12px;top:calc(env(safe-area-inset-top,0px) + 60px);padding:8px 14px;border-radius:999px;font:600 13px/1.2 system-ui,sans-serif;background:var(--accent);color:var(--on-accent);text-decoration:none;box-shadow:0 2px 8px rgb(0 0 0 / .2)';
    document.body.append(bar);
  } catch {}
})();
