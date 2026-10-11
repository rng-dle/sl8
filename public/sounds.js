// Writing sounds: filtered noise whose loudness follows how fast the pen moves. Each tool has its own tone.
// Off by default; the preference is kept on this device. Audio starts on the first stroke after it's turned on.
const scribble = (() => {
  // [band centre Hz, filter Q, loudness]
  const TONE = {
    pen: [2600, 1.1, 0.55], pencil: [4600, 0.7, 0.9], marker: [1300, 0.9, 0.5], brush: [800, 0.6, 0.4],
    nib: [2100, 1.6, 0.55], hl: [1500, 0.8, 0.45], eraser: [520, 0.5, 0.75],
  };
  let ac = null, filter, gain, tone = TONE.pen, on = store.get('sl8:sound') === true;

  function init() {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0, last = 0; i < data.length; i++) { last = 0.7 * last + 0.3 * (Math.random() * 2 - 1); data[i] = last; } // slightly soft white noise
    const src = ac.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    gain = ac.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ac.destination);
    src.start();
  }

  return {
    get on() { return on; },
    set on(v) { on = v; store.set('sl8:sound', v || null); if (!v && gain) gain.gain.value = 0; },
    start(kind) {
      if (!on) return;
      try {
        if (!ac) init();
        ac.resume();
        tone = TONE[kind] || TONE.pen;
        filter.frequency.value = tone[0];
        filter.Q.value = tone[1];
      } catch { on = false; } // no audio on this device
    },
    // speed in screen pixels per millisecond, pressure 0..1
    move(speed, pressure = 0.5) {
      if (!on || !ac) return;
      const level = Math.min(1, speed / 1.4) * tone[2] * (0.6 + 0.4 * pressure) * 0.35;
      gain.gain.setTargetAtTime(level, ac.currentTime, 0.025);
      filter.frequency.setTargetAtTime(tone[0] * (0.85 + Math.min(0.4, speed * 0.25)), ac.currentTime, 0.05);
    },
    stop() { if (ac && gain) gain.gain.setTargetAtTime(0, ac.currentTime, 0.04); },
    // the opening's paper tear: a crackly burst of noise rising in pitch
    rip() {
      try {
        if (!ac) init();
        ac.resume();
        const t = ac.currentTime, g = gain.gain, f = filter.frequency;
        g.cancelScheduledValues(t);
        f.cancelScheduledValues(t);
        filter.Q.value = 0.6;
        f.setValueAtTime(1500, t);
        f.linearRampToValueAtTime(4200, t + 0.4);
        for (let i = 0; i < 18; i++) g.setValueAtTime((0.12 + Math.random() * 0.4) * (1 - i / 22), t + i * 0.022);
        g.setTargetAtTime(0, t + 0.4, 0.06);
      } catch {} // no audio on this device
    },
  };
})();
addEventListener('visibilitychange', () => document.hidden && scribble.stop());

// The user's own tear sound (Settings): an audio file kept in this browser, like the other appearance settings.
const tearFile = {
  open: () => new Promise((ok, no) => {
    const r = indexedDB.open('sl8', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  }),
  async get() {
    try {
      const q = (await this.open()).transaction('files').objectStore('files').get('tear');
      return await new Promise((ok) => { q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); });
    } catch { return null; }
  },
  async set(file) { // null removes it
    const tx = (await this.open()).transaction('files', 'readwrite');
    file ? tx.objectStore('files').put(file, 'tear') : tx.objectStore('files').delete('tear');
    await new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  },
};
const TEAR_MAX_MS = 6000; // long files are cut off here

// Call early so the file has loaded; call what it returns at the moment of the tear.
function tearSoundPlayer() {
  const pick = store.get('sl8:tearSound') ?? 'rip';
  let audio = null, stop = 0;
  if (pick === 'own') tearFile.get().then((f) => { if (f) { audio = new Audio(URL.createObjectURL(f)); audio.preload = 'auto'; } });
  return () => {
    if (pick === 'off') return;
    if (!audio) return scribble.rip(); // the built-in rip, or the fallback if their file is gone
    audio.currentTime = 0;
    audio.play().catch(() => {}); // a browser may block sound before the page is touched
    clearTimeout(stop);
    stop = setTimeout(() => audio.pause(), TEAR_MAX_MS);
  };
}
