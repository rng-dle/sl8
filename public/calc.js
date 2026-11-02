// Scientific calculator engine: a small parser and evaluator, no eval. evaluate("2sin(30)+3!", { angle: 'deg' }) -> 4+... as a number.
// Supports + - × ÷ ^ ! % , brackets, implicit multiplication (2π, 2(3), (1+2)(3+4)), unary minus, constants, ~50 functions.
export class CalcError extends Error {}
const fail = (m) => { throw new CalcError(m); };

const GAMMA = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function gamma(z) { // Lanczos; reflection for z < 0.5
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += GAMMA[i] / (z + i + 1);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * a;
}
function fact(x) {
  if (x < 0 && Number.isInteger(x)) fail('Factorial of a negative integer is undefined');
  if (Number.isInteger(x)) {
    if (x > 170) fail('Too large');
    let r = 1; for (let i = 2; i <= x; i++) r *= i; return r;
  }
  if (x > 170) fail('Too large');
  return gamma(x + 1);
}
const int = (x, name) => { if (!Number.isInteger(x)) fail(`${name} needs whole numbers`); return x; };
function nCr(n, r) {
  int(n, 'nCr'); int(r, 'nCr');
  if (n < 0 || r < 0 || r > n) fail('nCr needs 0 ≤ r ≤ n');
  r = Math.min(r, n - r);
  let v = 1;
  for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i;
  return Math.round(v);
}
function nPr(n, r) {
  int(n, 'nPr'); int(r, 'nPr');
  if (n < 0 || r < 0 || r > n) fail('nPr needs 0 ≤ r ≤ n');
  let v = 1;
  for (let i = 0; i < r; i++) v *= n - i;
  return v;
}
const gcd = (a, b) => { a = Math.abs(int(a, 'gcd')); b = Math.abs(int(b, 'gcd')); while (b) [a, b] = [b, a % b]; return a; };
const clean = (v) => (Math.abs(v) < 1e-15 ? 0 : v); // sin(180°) is 0, not 1.2e-16
const domain = (v) => (Number.isFinite(v) ? v : fail('Not defined for that input'));

const unit = (ctx) => (ctx.angle === 'rad' ? 1 : ctx.angle === 'grad' ? Math.PI / 200 : Math.PI / 180);
const trig = (f) => (x, c) => domain(clean(f(x * unit(c))));
const inv = (f) => (x, c) => domain(f(x) / unit(c));
const sum = (a) => a.reduce((s, v) => s + v, 0);
const many = (f) => (...a) => f(...a.slice(0, -1)); // variadic: drop the trailing context argument

// name -> [min args, max args, fn(...args, ctx)]
const FN = {
  sin: [1, 1, trig(Math.sin)], cos: [1, 1, trig(Math.cos)],
  tan: [1, 1, (x, c) => { const cs = clean(Math.cos(x * unit(c))); return cs === 0 ? fail('tan is undefined here') : clean(Math.sin(x * unit(c))) / cs; }],
  asin: [1, 1, (x, c) => (Math.abs(x) > 1 ? fail('asin needs −1 to 1') : inv(Math.asin)(x, c))],
  acos: [1, 1, (x, c) => (Math.abs(x) > 1 ? fail('acos needs −1 to 1') : inv(Math.acos)(x, c))],
  atan: [1, 1, inv(Math.atan)],
  sec: [1, 1, (x, c) => 1 / FN.cos[2](x, c)], csc: [1, 1, (x, c) => 1 / FN.sin[2](x, c)], cot: [1, 1, (x, c) => 1 / FN.tan[2](x, c)],
  sinh: [1, 1, (x) => domain(Math.sinh(x))], cosh: [1, 1, (x) => domain(Math.cosh(x))], tanh: [1, 1, (x) => Math.tanh(x)],
  asinh: [1, 1, (x) => Math.asinh(x)], acosh: [1, 1, (x) => (x < 1 ? fail('acosh needs x ≥ 1') : Math.acosh(x))],
  atanh: [1, 1, (x) => (Math.abs(x) >= 1 ? fail('atanh needs −1 < x < 1') : Math.atanh(x))],
  ln: [1, 1, (x) => (x <= 0 ? fail('ln needs a positive number') : Math.log(x))],
  log: [1, 2, (x, b) => { if (typeof b !== 'number') return x <= 0 ? fail('log needs a positive number') : Math.log10(x); return x <= 0 || b <= 0 || b === 1 ? fail('log needs positive numbers and a base other than 1') : Math.log(x) / Math.log(b); }],
  log2: [1, 1, (x) => (x <= 0 ? fail('log needs a positive number') : Math.log2(x))],
  exp: [1, 1, (x) => domain(Math.exp(x))],
  sqrt: [1, 1, (x) => (x < 0 ? fail('Square root of a negative number') : Math.sqrt(x))],
  cbrt: [1, 1, (x) => Math.cbrt(x)],
  root: [2, 2, (x, n) => (n === 0 ? fail('Zeroth root') : x < 0 && Number.isInteger(n) && n % 2 !== 0 ? -Math.pow(-x, 1 / n) : x < 0 ? fail('Even root of a negative number') : Math.pow(x, 1 / n))],
  pow: [2, 2, (x, y) => domain(Math.pow(x, y))],
  abs: [1, 1, Math.abs], sign: [1, 1, Math.sign], floor: [1, 1, Math.floor], ceil: [1, 1, Math.ceil], trunc: [1, 1, Math.trunc],
  round: [1, 2, (x, d) => { const p = Math.pow(10, typeof d === 'number' ? d : 0); return Math.round(x * p) / p; }],
  fact: [1, 1, fact], ncr: [2, 2, nCr], npr: [2, 2, nPr], gamma: [1, 1, (x) => (x <= 0 && Number.isInteger(x) ? fail('Gamma is undefined here') : gamma(x))],
  gcd: [2, 2, gcd], lcm: [2, 2, (a, b) => (a === 0 || b === 0 ? 0 : Math.abs(int(a, 'lcm') * int(b, 'lcm')) / gcd(a, b))],
  mod: [2, 2, (a, b) => (b === 0 ? fail('Divide by zero') : ((a % b) + b) % b)],
  min: [1, 99, many(Math.min)], max: [1, 99, many(Math.max)], hypot: [1, 99, many(Math.hypot)],
  sum: [1, 99, many((...a) => sum(a))], avg: [1, 99, many((...a) => sum(a) / a.length)],
  deg: [1, 1, (x) => (x * 180) / Math.PI], rad: [1, 1, (x) => (x * Math.PI) / 180], // radians -> degrees, degrees -> radians
  rand: [0, 0, () => Math.random()],
};
const ALIAS = { arcsin: 'asin', arccos: 'acos', arctan: 'atan', asinh: 'asinh', lg: 'log', sqr: 'sqrt', '√': 'sqrt', ln: 'ln', npr: 'npr', ncr: 'ncr', cnr: 'ncr', perm: 'npr', comb: 'ncr', factorial: 'fact', ceiling: 'ceil', average: 'avg', mean: 'avg' };
const CONST = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2 };

function tokenize(src) {
  const s = src.replace(/×|·|⋅/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-').replace(/π/g, ' pi ').replace(/√/g, ' sqrt ').replace(/²/g, '^2').replace(/³/g, '^3').replace(/τ/g, ' tau ').replace(/φ/g, ' phi ');
  const out = [];
  const re = /\s+|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|([-+*/^!%(),])|(.)/gy;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) out.push({ k: 'n', v: Number(m[1]) });
    else if (m[2]) out.push({ k: 'id', v: m[2].toLowerCase() });
    else if (m[3]) out.push({ k: m[3] });
    else if (m[4]) fail(`Unexpected "${m[4]}"`);
  }
  return out;
}

function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i], eat = (k) => (tokens[i]?.k === k ? tokens[i++] : null);
  const startsPrimary = (t) => t && (t.k === 'n' || t.k === 'id' || t.k === '(');

  function expr() {
    let l = term();
    for (let t; (t = eat('+') || eat('-')); ) l = { t: 'bin', op: t.k, l, r: term() };
    return l;
  }
  function term() {
    let l = unary();
    for (;;) {
      const t = peek();
      if (eat('*') || eat('/')) l = { t: 'bin', op: t.k, l, r: unary() };
      else if (startsPrimary(t)) l = { t: 'bin', op: '*', l, r: unary() }; // 2π, 2(3), (1+2)(3+4)
      else return l;
    }
  }
  function unary() {
    if (eat('-')) return { t: 'neg', x: unary() };
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const b = postfix();
    if (eat('^')) return { t: 'bin', op: '^', l: b, r: unary() }; // right associative; 2^-3 works
    return b;
  }
  function postfix() {
    let x = primary();
    for (;;) {
      if (eat('!')) x = { t: 'fn', name: 'fact', args: [x] };
      else if (eat('%')) x = { t: 'pct', x };
      else return x;
    }
  }
  function primary() {
    const t = tokens[i];
    if (!t) fail('Unfinished expression');
    if (t.k === 'n') { i++; return { t: 'n', v: t.v }; }
    if (t.k === '(') {
      i++;
      const e = expr();
      if (!eat(')')) fail('Missing closing bracket');
      return e;
    }
    if (t.k === 'id') {
      i++;
      const name = ALIAS[t.v] || t.v;
      if (FN[name]) {
        let args;
        if (eat('(')) {
          args = [];
          if (!eat(')')) {
            do args.push(expr()); while (eat(','));
            if (!eat(')')) fail('Missing closing bracket');
          }
        } else if (startsPrimary(peek()) || peek()?.k === '-') args = [unary()]; // "sin 30", "sqrt 16"
        else fail(`${t.v} needs a value`);
        const [min, max] = FN[name];
        if (args.length < min || args.length > max) fail(`${t.v} takes ${min === max ? min : `${min} to ${max}`} value${max === 1 ? '' : 's'}`);
        return { t: 'fn', name, args };
      }
      if (name in CONST || name === 'ans' || name === 'm') return { t: 'c', name };
      fail(`Unknown name: ${t.v}`);
    }
    fail(t.k === ')' ? 'Unbalanced bracket' : `Unexpected "${t.k}"`);
  }

  const tree = expr();
  if (i < tokens.length) fail(tokens[i].k === ')' ? 'Unbalanced bracket' : `Unexpected "${tokens[i].k}"`);
  return tree;
}

function run(n, ctx) {
  switch (n.t) {
    case 'n': return n.v;
    case 'c': return n.name === 'ans' ? ctx.ans ?? 0 : n.name === 'm' ? ctx.memory ?? 0 : CONST[n.name];
    case 'neg': return -run(n.x, ctx);
    case 'pct': return run(n.x, ctx) / 100;
    case 'fn': return FN[n.name][2](...n.args.map((a) => run(a, ctx)), ctx);
    case 'bin': {
      const a = run(n.l, ctx);
      if (n.r.t === 'pct' && (n.op === '+' || n.op === '-')) { const p = run(n.r.x, ctx) / 100; return n.op === '+' ? a + a * p : a - a * p; } // 200 + 10% = 220
      const b = run(n.r, ctx);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? fail('Divide by zero') : a / b;
        case '^': return a < 0 && !Number.isInteger(b) ? fail('Power of a negative number') : domain(Math.pow(a, b));
      }
    }
  }
}

/** Evaluate text. ctx: { angle: 'deg' | 'rad' | 'grad', ans, memory }. Throws CalcError with a readable message. */
export function evaluate(text, ctx = {}) {
  const src = String(text).trim();
  if (!src) fail('Type something to calculate');
  if (src.length > 500) fail('Too long');
  const c = { angle: 'deg', ...ctx };
  const v = run(parse(tokenize(src)), c);
  if (typeof v !== 'number' || Number.isNaN(v)) fail('Not a number');
  if (!Number.isFinite(v)) fail('Too large');
  return v;
}

/** A number as text: 12 significant digits, scientific for very large or small. */
export function format(n) {
  if (n === 0 || Object.is(n, -0)) return '0';
  const a = Math.abs(n);
  if (a >= 1e15 || a < 1e-9) return n.toExponential(11).replace(/\.?0+e/, 'e').replace('e+', 'e');
  return String(parseFloat(n.toPrecision(12)));
}
