// Services a canvas can embed. One place for the worker (what a saved item may hold) and the page (reading a pasted link, building the frame).
// Each service: label, valid (the only refs the worker will store), parse(URL) -> ref | null, src(ref, host) -> frame address, size(ref) -> [w, h] of the player.
// A ref is only ever a short id or path, never a whole URL, so a saved canvas can't point a frame at an arbitrary site.
const seg = (u) => u.pathname.split('/').filter(Boolean);
const host = (u, ...names) => names.some((n) => u.hostname === n || u.hostname.endsWith('.' + n));
const ID = '[\\w-]';

export const EMBEDS = {
  spotify: {
    label: 'Spotify', valid: /^(track|album|playlist|artist|episode|show)\/[A-Za-z0-9]{22}$/,
    parse: (u) => { if (!host(u, 'spotify.com')) return null; const s = seg(u).filter((x) => !x.startsWith('intl-')); return s[0] && s[1] ? `${s[0]}/${s[1]}` : null; },
    src: (r) => `https://open.spotify.com/embed/${r}`,
    size: (r) => (/^(track|episode)/.test(r) ? [360, 152] : [360, 352]),
  },
  youtube: {
    label: 'YouTube', valid: /^(v\/[\w-]{11}|list\/[\w-]{10,60})$/,
    parse: (u) => {
      const s = seg(u);
      if (u.hostname === 'youtu.be') return /^[\w-]{11}$/.test(s[0]) ? `v/${s[0]}` : null;
      if (!host(u, 'youtube.com', 'youtube-nocookie.com')) return null;
      const v = u.searchParams.get('v') || (['shorts', 'embed', 'live'].includes(s[0]) ? s[1] : ''), list = u.searchParams.get('list');
      if (/^[\w-]{11}$/.test(v)) return `v/${v}`;
      return /^[\w-]{10,60}$/.test(list || '') ? `list/${list}` : null;
    },
    src: (r) => (r.startsWith('v/') ? `https://www.youtube.com/embed/${r.slice(2)}` : `https://www.youtube.com/embed/videoseries?list=${r.slice(5)}`),
    size: () => [480, 270],
  },
  soundcloud: {
    label: 'SoundCloud', valid: /^[\w-][\w.-]{0,59}(\/[\w-][\w.-]{0,99}){1,3}$/,
    parse: (u) => { const s = seg(u); return host(u, 'soundcloud.com') && s.length >= 2 && s.length <= 4 && !['discover', 'search', 'you', 'stream'].includes(s[0]) ? s.join('/') : null; },
    src: (r) => `https://w.soundcloud.com/player/?url=${encodeURIComponent('https://soundcloud.com/' + r)}`,
    size: (r) => [480, r.includes('/sets/') ? 300 : 166],
  },
  apple: {
    label: 'Apple Music', valid: /^[a-z]{2}\/(album|playlist|song|artist)\/[\w%][\w%.-]*(\/[\w%][\w%.-]*)?(\?i=\d{5,20})?$/,
    parse: (u) => { const s = seg(u); if (!host(u, 'music.apple.com') || !/^[a-z]{2}$/.test(s[0]) || s.length < 3) return null; const i = u.searchParams.get('i'); return s.join('/') + (i && /^\d+$/.test(i) ? `?i=${i}` : ''); },
    src: (r) => `https://embed.music.apple.com/${r}`,
    size: (r) => [480, /^[a-z]{2}\/(song)/.test(r) || r.includes('?i=') ? 175 : 450],
  },
  twitch: {
    label: 'Twitch', valid: /^(channel\/\w{3,25}|video\/\d{5,15}|clip\/[\w-]{5,100})$/,
    parse: (u) => {
      const s = seg(u);
      if (u.hostname === 'clips.twitch.tv') return s[0] ? `clip/${s[0]}` : null;
      if (!host(u, 'twitch.tv')) return null;
      if (s[0] === 'videos') return `video/${s[1]}`;
      if (s[1] === 'clip') return `clip/${s[2]}`;
      return s.length === 1 ? `channel/${s[0]}` : null;
    },
    src: (r, h) => { const [k, v] = r.split('/'); return k === 'clip' ? `https://clips.twitch.tv/embed?clip=${v}&parent=${h}` : `https://player.twitch.tv/?${k}=${v}&parent=${h}&autoplay=false`; },
    size: () => [480, 270],
  },
  tiktok: {
    label: 'TikTok', valid: /^\d{8,25}$/,
    parse: (u) => { const s = seg(u); return host(u, 'tiktok.com') && s[1] === 'video' && /^\d+$/.test(s[2]) ? s[2] : null; },
    src: (r) => `https://www.tiktok.com/embed/v2/${r}`,
    size: () => [340, 600],
  },
  gdoc: {
    label: 'Google Docs', valid: /^[\w-]{20,100}$/,
    parse: (u) => { const s = seg(u); return u.hostname === 'docs.google.com' && s[0] === 'document' && s[1] === 'd' ? s[2] : null; },
    src: (r) => `https://docs.google.com/document/d/${r}/preview`,
    size: () => [560, 420],
  },
  gsheet: {
    label: 'Google Sheets', valid: /^[\w-]{20,100}$/,
    parse: (u) => { const s = seg(u); return u.hostname === 'docs.google.com' && s[0] === 'spreadsheets' && s[1] === 'd' ? s[2] : null; },
    src: (r) => `https://docs.google.com/spreadsheets/d/${r}/preview`,
    size: () => [560, 420],
  },
  gslide: {
    label: 'Google Slides', valid: /^[\w-]{20,100}$/,
    parse: (u) => { const s = seg(u); return u.hostname === 'docs.google.com' && s[0] === 'presentation' && s[1] === 'd' ? s[2] : null; },
    src: (r) => `https://docs.google.com/presentation/d/${r}/preview`,
    size: () => [560, 340],
  },
  gdrive: {
    label: 'Google Drive', valid: /^[\w-]{20,100}$/,
    parse: (u) => { const s = seg(u); return u.hostname === 'drive.google.com' && s[0] === 'file' && s[1] === 'd' ? s[2] : null; },
    src: (r) => `https://drive.google.com/file/d/${r}/preview`,
    size: () => [560, 420],
  },
  gform: {
    label: 'Google Forms', valid: /^[\w-]{20,100}$/,
    parse: (u) => { const s = seg(u); return u.hostname === 'docs.google.com' && s[0] === 'forms' && s[1] === 'd' && s[2] === 'e' ? s[3] : null; },
    src: (r) => `https://docs.google.com/forms/d/e/${r}/viewform?embedded=true`,
    size: () => [480, 560],
  },
  gmaps: {
    label: 'Google Maps', valid: /^[^<>"'&#%\\\u0000-\u001f]{2,100}$/,
    parse: (u) => {
      if (!host(u, 'google.com') || seg(u)[0] !== 'maps') return null;
      const s = seg(u), place = s[1] === 'place' || s[1] === 'search' ? decodeURIComponent(s[2] || '').replace(/\+/g, ' ') : u.searchParams.get('q');
      return place && EMBEDS.gmaps.valid.test(place) ? place : null;
    },
    src: (r) => `https://www.google.com/maps?q=${encodeURIComponent(r)}&output=embed`,
    size: () => [480, 360],
  },
  gcal: {
    label: 'Google Calendar', valid: /^[\w.%+@-]{3,200}$/,
    parse: (u) => { const src = u.hostname === 'calendar.google.com' ? u.searchParams.get('src') : null; return src && EMBEDS.gcal.valid.test(src) ? src : null; },
    src: (r) => `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(r)}`,
    size: () => [560, 420],
  },
  figma: {
    label: 'Figma', valid: /^(file|design|proto|board)\/[A-Za-z0-9]{10,40}$/,
    parse: (u) => { const s = seg(u); return host(u, 'figma.com') && /^(file|design|proto|board)$/.test(s[0]) && /^[A-Za-z0-9]{10,40}$/.test(s[1] || '') ? `${s[0]}/${s[1]}` : null; },
    src: (r) => `https://www.figma.com/embed?embed_host=thinksl8&url=${encodeURIComponent('https://www.figma.com/' + r)}`,
    size: () => [560, 420],
  },
  canva: {
    label: 'Canva', valid: /^[\w-]{8,24}\/[\w-]{8,40}$/,
    parse: (u) => { const s = seg(u); return host(u, 'canva.com') && s[0] === 'design' && s[1] && s[2] ? `${s[1]}/${s[2]}` : null; },
    src: (r) => `https://www.canva.com/design/${r}/view?embed`,
    size: () => [480, 300],
  },
  // Any https page. Only the Mac app shows it live (a real browser tile placed over the canvas); everywhere else it is a link,
  // because sites forbid being framed. Never put this in an iframe.
  web: {
    label: 'Web page', valid: /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,24}(:\d{1,5})?(\/[^\s<>"'\\]{0,500})?$/i,
    parse: (u) => (u.protocol === 'https:' && !u.username && !u.password ? u.host + (u.pathname === '/' && !u.search ? '' : u.pathname + u.search) : null),
    src: (r) => `https://${r}`,
    size: () => [720, 480],
  },
  pinterest: {
    label: 'Pinterest', valid: /^\d{5,25}$/,
    parse: (u) => { const s = seg(u); return host(u, 'pinterest.com') && s[0] === 'pin' && /^\d+$/.test(s[1] || '') ? s[1] : null; },
    src: (r) => `https://assets.pinterest.com/ext/embed.html?id=${r}`,
    size: () => [300, 450],
  },
};

// A pasted link (or a spotify: uri, or a public calendar address) -> { service, ref }, or null if it isn't one we can embed
export function parseEmbed(text) {
  let t = String(text).trim();
  const uri = t.match(/^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]{22})$/);
  if (uri) return { service: 'spotify', ref: `${uri[1]}/${uri[2]}` };
  if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(t)) return EMBEDS.gcal.valid.test(t) ? { service: 'gcal', ref: t } : null;
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  let u;
  try { u = new URL(t); } catch { return null; }
  for (const [service, e] of Object.entries(EMBEDS).sort(([a], [b]) => (a === 'web') - (b === 'web'))) { // 'web' catches everything, so last
    let ref = null;
    try { ref = e.parse(u); } catch {}
    if (ref && e.valid.test(ref)) return { service, ref };
  }
  return null;
}
