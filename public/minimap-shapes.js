// The 20 shapes a minimap can take. mmPath(name, w, h) -> a Path2D filling the w x h box. Used by the canvas and by the picker in Settings.
const MM_SHAPES = [
  ['rounded', 'Rounded'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['pill', 'Pill'], ['squircle', 'Squircle'],
  ['diamond', 'Diamond'], ['hexagon', 'Hexagon'], ['octagon', 'Octagon'], ['pentagon', 'Pentagon'], ['triangle', 'Triangle'],
  ['star', 'Star'], ['cross', 'Cross'], ['heart', 'Heart'], ['shield', 'Shield'], ['parallelogram', 'Slanted'],
  ['trapezoid', 'Trapezoid'], ['chevron', 'Arrow'], ['notched', 'Cut corners'], ['ticket', 'Ticket'], ['bubble', 'Speech bubble'],
];
function mmPath(name, w, h) {
  const p = new Path2D(), poly = (pts) => { pts.forEach(([x, y], i) => (i ? p.lineTo(x * w, y * h) : p.moveTo(x * w, y * h))); p.closePath(); };
  const r = (rx, ry = rx) => { // rounded rectangle with corner radii in pixels
    p.moveTo(rx, 0); p.lineTo(w - rx, 0); p.quadraticCurveTo(w, 0, w, ry); p.lineTo(w, h - ry); p.quadraticCurveTo(w, h, w - rx, h);
    p.lineTo(rx, h); p.quadraticCurveTo(0, h, 0, h - ry); p.lineTo(0, ry); p.quadraticCurveTo(0, 0, rx, 0); p.closePath();
  };
  switch (name) {
    case 'rect': p.rect(0, 0, w, h); break;
    case 'ellipse': p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'pill': r(h / 2); break;
    case 'squircle': { // superellipse, exponent 4
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), x = w / 2 + (w / 2) * Math.sign(c) * Math.abs(c) ** 0.5, y = h / 2 + (h / 2) * Math.sign(s) * Math.abs(s) ** 0.5;
        i ? p.lineTo(x, y) : p.moveTo(x, y);
      }
      p.closePath(); break;
    }
    case 'diamond': poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]); break;
    case 'hexagon': poly([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]); break;
    case 'octagon': poly([[0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3]]); break;
    case 'pentagon': poly([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]); break;
    case 'triangle': poly([[0.5, 0], [1, 1], [0, 1]]); break;
    case 'star': poly(Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? 0.22 : 0.5; return [0.5 + Math.cos(a) * k, 0.5 + Math.sin(a) * k]; })); break;
    case 'cross': poly([[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]]); break;
    case 'heart':
      p.moveTo(w * 0.5, h * 0.95); p.bezierCurveTo(w * -0.1, h * 0.55, w * 0.05, h * 0.02, w * 0.3, h * 0.05);
      p.bezierCurveTo(w * 0.42, h * 0.06, w * 0.5, h * 0.18, w * 0.5, h * 0.28); p.bezierCurveTo(w * 0.5, h * 0.18, w * 0.58, h * 0.06, w * 0.7, h * 0.05);
      p.bezierCurveTo(w * 0.95, h * 0.02, w * 1.1, h * 0.55, w * 0.5, h * 0.95); p.closePath(); break;
    case 'shield': p.moveTo(0.05 * w, 0.1 * h); p.lineTo(0.5 * w, 0); p.lineTo(0.95 * w, 0.1 * h); p.lineTo(0.95 * w, 0.5 * h); p.quadraticCurveTo(0.9 * w, 0.85 * h, 0.5 * w, h); p.quadraticCurveTo(0.1 * w, 0.85 * h, 0.05 * w, 0.5 * h); p.closePath(); break;
    case 'parallelogram': poly([[0.18, 0], [1, 0], [0.82, 1], [0, 1]]); break;
    case 'trapezoid': poly([[0.15, 0], [0.85, 0], [1, 1], [0, 1]]); break;
    case 'chevron': poly([[0, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0, 1], [0.25, 0.5]]); break;
    case 'notched': { const n = Math.min(w, h) * 0.22; p.moveTo(n, 0); p.lineTo(w - n, 0); p.lineTo(w, n); p.lineTo(w, h - n); p.lineTo(w - n, h); p.lineTo(n, h); p.lineTo(0, h - n); p.lineTo(0, n); p.closePath(); break; }
    case 'ticket': { const n = Math.min(w, h) * 0.16; p.moveTo(0, 0); p.lineTo(w, 0); p.lineTo(w, h / 2 - n); p.arc(w, h / 2, n, -Math.PI / 2, Math.PI / 2, true); p.lineTo(w, h); p.lineTo(0, h); p.lineTo(0, h / 2 + n); p.arc(0, h / 2, n, Math.PI / 2, -Math.PI / 2, true); p.closePath(); break; }
    case 'bubble': { const b = h * 0.85, rr = Math.min(w, b) * 0.2; p.moveTo(rr, 0); p.lineTo(w - rr, 0); p.quadraticCurveTo(w, 0, w, rr); p.lineTo(w, b - rr); p.quadraticCurveTo(w, b, w - rr, b); p.lineTo(w * 0.34, b); p.lineTo(w * 0.16, h); p.lineTo(w * 0.2, b); p.lineTo(rr, b); p.quadraticCurveTo(0, b, 0, b - rr); p.lineTo(0, rr); p.quadraticCurveTo(0, 0, rr, 0); p.closePath(); break; }
    default: r(Math.min(w, h) * 0.12);
  }
  return p;
}
// how far in from each edge the map itself sits, as a fraction of the box, so it isn't cut off by the shape
const MM_INSET = { rect: 0.03, rounded: 0.05, squircle: 0.08, pill: 0.14, ellipse: 0.15, diamond: 0.28, hexagon: 0.14, octagon: 0.12, pentagon: 0.2, triangle: 0.3, star: 0.3, cross: 0.1, heart: 0.2, shield: 0.12, parallelogram: 0.13, trapezoid: 0.12, chevron: 0.13, notched: 0.1, ticket: 0.1, bubble: 0.08 };
