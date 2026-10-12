// The 21 shapes a minimap can take. mmPath(name, w, h) -> a Path2D filling the w x h box. Used by the canvas and by the picker in Settings.
const MM_SHAPES = [
  ['rounded', 'Rounded'], ['rect', 'Rectangle'], ['circle', 'Circle'], ['ellipse', 'Ellipse'], ['pill', 'Pill'], ['squircle', 'Squircle'],
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
    case 'circle': p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break; // the box is square (see MM_ASPECT)
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
    case 'star': { // a regular five-point star, scaled to fill the box (looks right at about 1.05:1)
      const pts = Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? 0.382 : 1; return [Math.cos(a) * k, Math.sin(a) * k]; });
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      poly(pts.map(([x, y]) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)])); break;
    }
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
// Width over height each shape is drawn at, so squares stay square and a hexagon, star or triangle keeps its true proportions
const MM_ASPECT = { rounded: 1.5, rect: 1.5, pill: 1.7, squircle: 1.4, ellipse: 1.4, circle: 1, diamond: 1, hexagon: 1.155, octagon: 1, pentagon: 1.05, triangle: 1.155, star: 1.05, cross: 1, heart: 1.1, shield: 0.9, parallelogram: 1.6, trapezoid: 1.5, chevron: 1.6, notched: 1.5, ticket: 1.6, bubble: 1.4 };
// the rectangle inside each shape where the map itself is drawn: [left, top, right, bottom] as fractions of the box
const MM_BOX = { rounded: [.04, .06, .96, .94], rect: [.04, .06, .96, .94], pill: [.12, .1, .88, .9], squircle: [.08, .08, .92, .92], ellipse: [.15, .15, .85, .85], circle: [.15, .15, .85, .85],
  diamond: [.25, .25, .75, .75], hexagon: [.15, .2, .85, .8], octagon: [.15, .15, .85, .85], pentagon: [.2, .4, .8, .92], triangle: [.28, .5, .72, .94],
  star: [.3, .4, .7, .72], cross: [.06, .37, .94, .63], heart: [.22, .2, .78, .62], shield: [.14, .1, .86, .62], parallelogram: [.22, .1, .78, .9],
  trapezoid: [.2, .1, .8, .9], chevron: [.28, .1, .72, .9], notched: [.1, .1, .9, .9], ticket: [.12, .08, .88, .92], bubble: [.06, .06, .94, .78] };
// size in CSS pixels for a shape: the longer side is 150 (wide shapes) or 116 (squarish ones)
const mmSize = (name) => { const a = MM_ASPECT[name] || 1.5, d = a >= 1.3 || a <= 0.8 ? 150 : 116; return a >= 1 ? [d, Math.round(d / a)] : [Math.round(d * a), d]; };
