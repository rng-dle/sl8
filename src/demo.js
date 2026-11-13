// The guest demo: seven canvases that show what ThinkSL8 does, copied fresh into every guest account (worker.js: guestStart).
// Text is laid out by estimate (col) so nothing overlaps. Portals name the canvas they open by key.
// Photos, videos and voice notes need uploaded files, so they are described, not shown.

const LINE = 1.45; // line height in font sizes
// Estimated height of a text card: wrapped lines at about half a font size per character, plus padding.
const heightOf = (w, s, text) => Math.ceil(text.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil((p.length * s * 0.52) / w)), 0) * s * LINE) + 24;

// Stack cards down a column: [size, colour, text] each. Returns the items and the y where the column ends.
function col(x, y, w, rows, key) {
  const items = [];
  rows.forEach(([s, c, text], i) => {
    items.push({ k: `${key}${i}`, kind: 'text', x, y, w, s, c, text });
    y += heightOf(w, s, text);
  });
  return { items, end: y };
}

// A hand-drawn-looking stroke: [x, y, pressure, ...] points along a shape.
const stroke = (k, c, w, pts) => ({ k, kind: 'stroke', c, w, pr: true, p: pts.flatMap(([x, y], i) => [Math.round(x), Math.round(y), +(0.35 + 0.5 * Math.sin((i / (pts.length - 1)) * Math.PI)).toFixed(2)]) });
const circle = (cx, cy, r, n = 48) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * 1.0 * Math.sin((i / n) * 2 * Math.PI)]);
const wave = (x, y, len, amp, n = 40) => Array.from({ length: n + 1 }, (_, i) => [x + (i / n) * len, y + amp * Math.sin((i / n) * 4 * Math.PI)]);

const portal = (k, to, x, y) => ({ k, kind: 'portal', to, x, y, w: 240, h: 132 });

const start = (() => {
  const a = col(0, 0, 560, [[32, 'ink', 'Welcome to ThinkSL8'], [17, 'ink', 'An endless canvas for your thoughts. This is a guest demo: play with everything, break it, nothing here is kept for long. It is wiped about 24 hours after you start.']], 's');
  const b = col(0, a.end + 16, 340, [[17, 'blue', 'Tap "Show me around" in the menu for a 1 minute guided tour.'], [17, 'green', 'The six numbered cards below are portals. Go through them in order, then come back here from Canvases.']], 't');
  const y = b.end + 24;
  return { key: 'start', title: 'Start here', style: { theme: 'light', pattern: 'dots' }, items: [...a.items, ...b.items,
    portal('p1', 'write', 0, y), portal('p2', 'pen', 288, y), portal('p3', 'map', 576, y),
    portal('p4', 'embed', 0, y + 180), portal('p5', 'ai', 288, y + 180), portal('p6', 'look', 576, y + 180)] };
})();

const write = (() => {
  const a = col(0, 0, 480, [[28, 'ink', 'Writing: no folders, no titles'], [17, 'ink', 'Double-click or double-tap anywhere to write. Put things next to each other instead of filing them.']], 'a');
  const todo = col(0, a.end + 24, 240, [[17, 'ink', 'To do\n\n- reply to Sam\n- book flights'], [17, 'blue', 'In progress\n\n- draft the pitch']], 'b');
  const done = col(288, a.end + 24, 240, [[17, 'green', 'Done\n\n- invoice sent\n- taxes filed'], [17, 'red', 'Blocked\n\n- waiting on legal']], 'c');
  const tip = col(576, a.end + 24, 300, [[17, 'orange', 'Zones: group related cards in a region and leave blank space around it. One canvas can hold a whole project, so you rarely need a new one.'], [17, 'ink', 'Five ink colours, any size. Select several cards with the box tool to move or delete them together.']], 'd');
  return { key: 'write', title: '1 · Writing and zones', style: { theme: 'paper', pattern: 'lines' }, items: [...a.items, ...todo.items, ...done.items, ...tip.items] };
})();

const pen = (() => {
  const a = col(0, 0, 520, [[28, 'ink', 'Pen and sketching'], [17, 'ink', 'Pick the pen to handwrite or draw. With a stylus, pressure shapes the line and your palm is ignored. Try it below.']], 'a');
  const y = a.end + 40;
  return { key: 'pen', title: '2 · Pen and sketching', style: { theme: 'chalk', pattern: 'dots' }, items: [...a.items,
    stroke('s1', 'blue', 4, circle(120, y + 100, 80)), stroke('s2', 'red', 4, wave(300, y + 100, 320, 40)),
    stroke('s3', 'green', 3, [[20, y + 240], [120, y + 280], [220, y + 240], [320, y + 290], [420, y + 240]]),
    { k: 'n1', kind: 'text', x: 0, y: y + 340, w: 480, s: 17, c: 'orange', text: 'The eraser removes strokes. Undo works on everything. Your drawing sits on the same canvas as your text, so you can sketch around a note.' }] };
})();

const map = (() => {
  const items = [
    { k: 'c', kind: 'text', x: 336, y: 168, w: 288, s: 24, c: 'ink', text: 'Launch plan' },
    { k: 'm', kind: 'text', x: 0, y: 0, w: 240, s: 17, c: 'blue', text: 'Marketing\n\nwebsite, email list' },
    { k: 'e', kind: 'text', x: 720, y: 0, w: 240, s: 17, c: 'green', text: 'Engineering\n\nfinish signup flow' },
    { k: 'o', kind: 'text', x: 0, y: 420, w: 240, s: 17, c: 'orange', text: 'Operations\n\nsupport inbox, billing' },
    { k: 'f', kind: 'text', x: 720, y: 420, w: 240, s: 17, c: 'red', text: 'Risks\n\nunder-tested payments' },
    { k: 'h', kind: 'text', x: 336, y: 600, w: 360, s: 17, c: 'ink', text: 'Arrows: drag from a card to another to link them. The links follow the cards when you move them. Use it for mind maps, flows and dependencies.' },
  ];
  ['m', 'e', 'o', 'f'].forEach((to, i) => items.push({ k: 'l' + i, kind: 'conn', a: 'c', b: to, c: 'ink' }));
  return { key: 'map', title: '3 · Arrows and maps', style: { theme: 'blueprint', pattern: 'grid' }, items };
})();

const embed = (() => {
  const a = col(0, 0, 400, [[28, 'ink', 'Embeds'], [17, 'ink', 'Paste a Spotify, YouTube or SoundCloud link onto a canvas and it plays right there, next to your notes.'], [17, 'orange', 'Photos, videos and voice recordings work the same way. They need a free account, so they are off in the guest demo.']], 'a');
  return { key: 'embed', title: '4 · Embeds and media', style: { theme: 'dark', pattern: 'dots' }, items: [...a.items,
    { k: 'sp', kind: 'embed', service: 'spotify', ref: 'playlist/37i9dQZF1DXcBWIGoYBM5M', x: 480, y: 0, w: 360, h: 352 }] };
})();

const ai = (() => {
  const a = col(0, 0, 520, [[28, 'ink', 'Bring your own AI'], [17, 'ink', 'Use Ask AI to ask about what you wrote and get answers with links back to the notes it used. Connect your own provider, so there is no markup on tokens.'],
    [17, 'blue', 'Claude connector: ThinkSL8 speaks MCP, so Claude (or any MCP client) can read your canvases, add notes, and move things around, with permissions you choose per connection.'],
    [17, 'green', 'AI to AI: connected assistants can leave each other messages on a bridge, so they can hand work over without you in the middle.'],
    [17, 'red', 'Guest demo limit: connecting an AI is off here. Create a free account to try it.']], 'a');
  return { key: 'ai', title: '5 · AI and connectors', style: { theme: 'paper', pattern: 'graph' }, items: a.items };
})();

const look = (() => {
  const a = col(0, 0, 480, [[28, 'ink', 'Make it yours'], [17, 'ink', 'Every canvas has its own look. This whole demo uses a different theme and grid on each canvas: light, paper, chalk, blueprint and dark, with dots, lines, graph paper or grid.'],
    [17, 'blue', 'The Market has templates and themes. Use one to start a canvas, or publish your own.'], [17, 'green', 'Share a canvas, or only chosen squares of it, by link as view or edit. Needs a verified account.'],
    [17, 'orange', 'Installs as an app on phone and Mac, and works offline on the Mac app.']], 'a');
  return { key: 'look', title: '6 · Themes, sharing', style: { theme: 'chalk', pattern: 'iso' }, items: a.items };
})();

// start first: its portals open the others
export const DEMO = [start, write, pen, map, embed, ai, look];
