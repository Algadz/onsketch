import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, isEquation, references, parse } from '../../app/src/core/expr.js';
import { ensureDimensionNames, solveEquations, userValue, internalValue, validateName, renameReferences } from '../../app/src/core/equations.js';
import { Project } from '../../app/src/core/model.js';
import { Point, Line, Circle } from '../../app/src/core/entities.js';
import * as C from '../../app/src/core/constraints.js';

const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

test('units convert to mm and degrees', () => {
  assert.ok(near(evaluate('4in'), 101.6));
  assert.ok(near(evaluate('4 in'), 101.6));
  assert.ok(near(evaluate('2"'), 50.8));
  assert.ok(near(evaluate("1'"), 304.8));
  assert.ok(near(evaluate('2ft'), 609.6));
  assert.ok(near(evaluate('3.5cm'), 35));
  assert.ok(near(evaluate('0.25m'), 250));
  assert.ok(near(evaluate('4mm'), 4));
  assert.ok(near(evaluate('30deg'), 30));
  assert.ok(near(evaluate('30°'), 30));
  assert.ok(near(evaluate('1rad'), 180 / Math.PI));
  assert.ok(near(evaluate('1in + 4mm'), 29.4));
});

test('arithmetic, precedence, functions in degrees', () => {
  assert.equal(evaluate('2+3*4'), 14);
  assert.equal(evaluate('(2+3)*4'), 20);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^3^2'), 512);
  assert.ok(near(evaluate('sin(30)'), 0.5));
  assert.ok(near(evaluate('atan(1)'), 45));
  assert.ok(near(evaluate('sqrt(2)*sqrt(2)'), 2));
  assert.equal(evaluate('max(3, 7, 5)'), 7);
  assert.ok(near(evaluate('pi'), Math.PI));
  assert.equal(evaluate('=10/4'), 2.5);
  assert.equal(evaluate('1e2'), 100);
});

test('names, errors and equation detection', () => {
  const look = (n) => ({ D1: 20, width: 50 })[n];
  assert.equal(evaluate('=D1*2 + 5', look), 45);
  assert.equal(evaluate('width/2', look), 25);
  assert.deepEqual(references('D1*2 + width + sin(30)').sort(), ['D1', 'width']);
  assert.throws(() => evaluate('D9*2', look), /Unknown name "D9"/);
  assert.throws(() => evaluate('1/0'), /Division by zero/);
  assert.throws(() => evaluate('(1+2'), /Missing "\)"/);
  assert.throws(() => evaluate('foo(2)'), /Unknown function/);
  assert.throws(() => evaluate('2 $ 3'), /Unexpected/);
  assert.throws(() => parse(''), /Empty/);
  assert.ok(isEquation('=10'));
  assert.ok(isEquation('D1/2'));
  assert.ok(!isEquation('4in'));
  assert.ok(!isEquation('10+5'));
});

function sample() {
  const p = new Project(); const s = p.addSketch('A');
  const a = new Line(new Point(0, 0), new Point(10, 0)); s.addEntity(a);
  const c = new Circle(new Point(30, 0), 5); s.addEntity(c);
  const d1 = new C.DistanceConstraint(a.p1.id, a.p2.id, 10);
  const d2 = new C.RadiusConstraint(c.id, 5); d2.isDiameter = true;
  const d3 = new C.AngleConstraint({ a: a.p1.id, b: a.p2.id }, { a: a.p1.id, b: a.p2.id }, Math.PI / 6);
  s.constraints.push(d1, d2, d3);
  ensureDimensionNames(p);
  return { p, s, d1, d2, d3 };
}

test('dimensions get unique names; user values are degrees and diameters', () => {
  const { d1, d2, d3 } = sample();
  assert.deepEqual([d1.name, d2.name, d3.name], ['D1', 'D2', 'D3']);
  assert.equal(userValue(d2), 10);
  assert.ok(near(userValue(d3), 30));
  assert.ok(near(internalValue(d3, 45), Math.PI / 4));
  assert.equal(internalValue(d2, 12), 6);
});

test('equations evaluate in dependency order through variables', () => {
  const { p, d1, d2, d3 } = sample();
  p.variables.push({ name: 'width', expr: '2in' });
  d1.expr = 'D2 * 2';               // depends on D2, evaluated later in the list
  d2.expr = 'width / 2';            // diameter = 25.4
  d3.expr = '90 - 60';
  const apply = (c, v) => { c.value = internalValue(c, v); };
  assert.equal(solveEquations(p, apply), 0);
  assert.ok(near(userValue(d2), 25.4) && near(d2.value, 12.7));
  assert.ok(near(d1.value, 50.8));
  assert.ok(near(d3.value, Math.PI / 6));
  assert.ok(near(p.variables[0].value, 50.8));
});

test('cycles and bad references are reported, not applied', () => {
  const { p, d1, d2 } = sample();
  d1.expr = 'D2'; d2.expr = 'D1 + 1';
  const before = [d1.value, d2.value];
  assert.equal(solveEquations(p, (c, v) => { c.value = v; }), 2);
  assert.match(d1.exprError, /Circular/);
  assert.deepEqual([d1.value, d2.value], before);
  d1.expr = 'nope * 2'; d2.expr = null;
  solveEquations(p, () => {});
  assert.match(d1.exprError, /Unknown name/);
  d1.expr = '-5';
  solveEquations(p, () => {});
  assert.match(d1.exprError, /greater than 0/);
});

test('names validate and renames follow into expressions; all of it saves', () => {
  const { p, d1, d2 } = sample();
  assert.match(validateName(p, 'D2', d1), /already used/);
  assert.match(validateName(p, 'sin'), /reserved/);
  assert.match(validateName(p, '2x'), /letters/);
  assert.equal(validateName(p, 'length', d1), null);
  d2.expr = 'D1 / 2 + D10';
  renameReferences(p, 'D1', 'length'); d1.name = 'length';
  assert.equal(d2.expr, 'length / 2 + D10');
  p.variables.push({ name: 'gap', expr: '3mm' });
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const cs = q.sketches[0].constraints;
  assert.equal(cs[0].name, 'length');
  assert.equal(cs[1].expr, 'length / 2 + D10');
  assert.deepEqual(q.variables, [{ name: 'gap', expr: '3mm' }]);
});
