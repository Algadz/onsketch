/* =============== EXPRESSIONS ===================================
   Safe evaluator for dimension values and equations (no eval).

     25            plain number, in the project unit (mm) or degrees
     4in  1.5"     units: mm cm m in " ft '  (lengths → mm)
     30deg 0.5rad  units: deg ° rad          (angles → degrees)
     =D1*2 + 5mm   names of other dimensions and global variables
     sqrt(2)*D3    functions: sin cos tan asin acos atan sqrt abs
                   min max round floor ceil;  constant pi
     + - * / ^ ( )

   Trigonometric functions work in degrees, as is usual in CAD.
   ============================================================ */

export const LENGTH_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, ft: 304.8, "'": 304.8 };
export const ANGLE_UNITS = { deg: 1, '°': 1, rad: 180 / Math.PI };
const UNITS = { ...LENGTH_UNITS, ...ANGLE_UNITS };

const D2R = Math.PI / 180;
const FUNCS = {
  sin: (x) => Math.sin(x * D2R), cos: (x) => Math.cos(x * D2R), tan: (x) => Math.tan(x * D2R),
  asin: (x) => Math.asin(x) / D2R, acos: (x) => Math.acos(x) / D2R, atan: (x) => Math.atan(x) / D2R,
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max,
};
const CONSTS = { pi: Math.PI };

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isReservedName = (n) => n in FUNCS || n in CONSTS || n in UNITS;

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      toks.push({ t: 'num', v: parseFloat(num[0]) });
      i += num[0].length;
      // A unit right after a number (optionally one space): 4in, 4 mm, 2', 30°
      const rest = src.slice(i);
      const u = /^ ?(mm|cm|inches|inch|in|ft|deg|rad|m|°|"|')(?![A-Za-z0-9_])/.exec(rest);
      if (u) { toks.push({ t: 'unit', v: u[1] }); i += u[0].length; }
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { toks.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/^(),'.includes(ch)) { toks.push({ t: ch }); i++; continue; }
    throw new Error(`Unexpected "${ch}"`);
  }
  return toks;
}

/** Parse to a tree. Grammar: sum := prod (('+'|'-') prod)* ;
 *  prod := unary (('*'|'/') unary)* ; unary := '-' unary | pow ;
 *  pow := atom ('^' unary)? ; atom := num unit? | name | name '(' args ')' | '(' sum ')' */
export function parse(src) {
  const toks = tokenize(String(src).trim().replace(/^=/, ''));
  if (!toks.length) throw new Error('Empty value');
  let k = 0;
  const peek = () => toks[k];
  const take = (t) => { if (toks[k]?.t !== t) throw new Error(t === ')' ? 'Missing ")"' : `Expected "${t}"`); return toks[k++]; };
  const sum = () => {
    let n = prod();
    while (peek() && (peek().t === '+' || peek().t === '-')) n = { op: toks[k++].t, a: n, b: prod() };
    return n;
  };
  const prod = () => {
    let n = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) n = { op: toks[k++].t, a: n, b: unary() };
    return n;
  };
  const unary = () => {
    if (peek()?.t === '-') { k++; return { op: 'neg', a: unary() }; }
    if (peek()?.t === '+') { k++; return unary(); }
    return pow();
  };
  const pow = () => {
    const base = atom();
    if (peek()?.t === '^') { k++; return { op: '^', a: base, b: unary() }; }
    return base;
  };
  const atom = () => {
    const tk = toks[k++];
    if (!tk) throw new Error('Incomplete expression');
    if (tk.t === 'num') {
      if (peek()?.t === 'unit') return { num: tk.v, unit: toks[k++].v };
      return { num: tk.v };
    }
    if (tk.t === '(') { const n = sum(); take(')'); return n; }
    if (tk.t === 'id') {
      if (peek()?.t === '(') {
        if (!(tk.v in FUNCS)) throw new Error(`Unknown function "${tk.v}"`);
        k++;
        const args = [];
        if (peek()?.t !== ')') { args.push(sum()); while (peek()?.t === ',') { k++; args.push(sum()); } }
        take(')');
        return { fn: tk.v, args };
      }
      if (tk.v in CONSTS) return { num: CONSTS[tk.v] };
      return { name: tk.v };
    }
    throw new Error(`Unexpected "${tk.t}"`);
  };
  const tree = sum();
  if (k < toks.length) throw new Error(`Unexpected "${toks[k].v ?? toks[k].t}"`);
  return tree;
}

/** Names referenced by an expression (dimensions / variables). */
export function references(src) {
  const out = new Set();
  const walk = (n) => {
    if (!n) return;
    if (n.name) out.add(n.name);
    if (n.a) walk(n.a);
    if (n.b) walk(n.b);
    if (n.args) n.args.forEach(walk);
  };
  walk(parse(src));
  return [...out];
}

/**
 * Evaluate an expression.
 * @param {string} src
 * @param {(name:string)=>number|undefined} lookup  value of a name
 * @returns {number} in mm for lengths, degrees for angles
 */
export function evaluate(src, lookup = () => undefined) {
  const ev = (n) => {
    if ('num' in n) return n.unit ? n.num * UNITS[n.unit] : n.num;
    if (n.name) {
      const v = lookup(n.name);
      if (v === undefined || !Number.isFinite(v)) throw new Error(`Unknown name "${n.name}"`);
      return v;
    }
    if (n.fn) return FUNCS[n.fn](...n.args.map(ev));
    switch (n.op) {
      case 'neg': return -ev(n.a);
      case '+': return ev(n.a) + ev(n.b);
      case '-': return ev(n.a) - ev(n.b);
      case '*': return ev(n.a) * ev(n.b);
      case '/': { const d = ev(n.b); if (d === 0) throw new Error('Division by zero'); return ev(n.a) / d; }
      case '^': return Math.pow(ev(n.a), ev(n.b));
    }
    throw new Error('Bad expression');
  };
  const v = ev(parse(src));
  if (!Number.isFinite(v)) throw new Error('Result is not a number');
  return v;
}

/** True when the text should be kept as an equation: it starts with "="
 *  or refers to a dimension / variable. "4in" or "10+5" are just values. */
export function isEquation(src) {
  const s = String(src).trim();
  if (s.startsWith('=')) return true;
  try { return references(s).length > 0; } catch { return false; }
}
