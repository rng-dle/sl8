// Pasted links -> embeds: every supported service is read from a typical link, and unsafe or unsupported links are refused. Exits non-zero on failure.
import { parseEmbed, EMBEDS } from '../public/embeds.js';
let failed = 0;
const ok = (c, n, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} - ${n}${!c && x ? ` ${x}` : ''}`); if (!c) failed++; };
const id22 = 'a'.repeat(22), gid = 'A1b2C3d4E5f6G7h8I9j0K1l2';
const cases = [
  [`https://open.spotify.com/intl-fr/track/${id22}?si=x`, 'spotify', `track/${id22}`],
  [`spotify:playlist:${id22}`, 'spotify', `playlist/${id22}`],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5', 'youtube', 'v/dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'v/dQw4w9WgXcQ'],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'v/dQw4w9WgXcQ'],
  ['https://soundcloud.com/some-artist/some-track', 'soundcloud', 'some-artist/some-track'],
  ['https://music.apple.com/us/album/some-album/123456789?i=987654321', 'apple', 'us/album/some-album/123456789?i=987654321'],
  ['https://www.twitch.tv/somechannel', 'twitch', 'channel/somechannel'],
  ['https://www.twitch.tv/videos/123456789', 'twitch', 'video/123456789'],
  ['https://www.tiktok.com/@someone/video/7234567890123456789', 'tiktok', '7234567890123456789'],
  [`https://docs.google.com/document/d/${gid}/edit`, 'gdoc', gid],
  [`https://docs.google.com/spreadsheets/d/${gid}/edit#gid=0`, 'gsheet', gid],
  [`https://docs.google.com/presentation/d/${gid}/edit`, 'gslide', gid],
  [`https://drive.google.com/file/d/${gid}/view`, 'gdrive', gid],
  [`https://docs.google.com/forms/d/e/${gid}/viewform`, 'gform', gid],
  ['https://www.google.com/maps/place/Badshahi+Mosque/@31.5,74.3,17z', 'gmaps', 'Badshahi Mosque'],
  ['https://calendar.google.com/calendar/embed?src=someone%40gmail.com', 'gcal', 'someone@gmail.com'],
  ['https://www.figma.com/design/AbCdEfGhIjKlMn/My-file', 'figma', 'design/AbCdEfGhIjKlMn'],
  ['https://www.canva.com/design/DAFabcdefgh/AbCdEfGhIjKlMn/view', 'canva', 'DAFabcdefgh/AbCdEfGhIjKlMn'],
  ['https://www.pinterest.com/pin/123456789012/', 'pinterest', '123456789012'],
];
for (const [link, service, ref] of cases) {
  const r = parseEmbed(link);
  ok(r?.service === service && r.ref === ref, `${service}: ${link.slice(0, 60)}`, JSON.stringify(r));
}
for (const bad of ['javascript:alert(1)', 'not a link', 'http://insecure.example/page', 'https://user:pw@example.com/', 'https://localhost/x', 'data:text/html,hi']) {
  ok(parseEmbed(bad) === null, `refused: ${bad}`, JSON.stringify(parseEmbed(bad)));
}
ok(Object.values(EMBEDS).every((e) => /^https:\/\//.test(e.src(e.size.length ? 'x' : 'x', 'thinksl8.com'))), 'every frame address is https');
// any other https page becomes a web tile (live only in the Mac app; a link everywhere else), after every named service
for (const [link, ref] of [['https://open.spotify.com/', 'open.spotify.com'], ['https://en.wikipedia.org/wiki/Cat?x=1', 'en.wikipedia.org/wiki/Cat?x=1'], ['https://www.pinterest.com/someone/board/', 'www.pinterest.com/someone/board/']]) {
  const r = parseEmbed(link);
  ok(r?.service === 'web' && r.ref === ref && EMBEDS.web.valid.test(ref), `web tile: ${link}`, JSON.stringify(r));
}
ok(parseEmbed(`https://open.spotify.com/track/${id22}`).service === 'spotify', 'named services win over the web catch-all');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
