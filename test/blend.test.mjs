import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnchors, monthlyResiduals, idwResidualAt } from '../src/blend.js';

function approx(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: expected ${expected}±${tol}, got ${actual}`,
  );
}

const FLAT10 = new Float64Array(12).fill(10);

test('anchors come from sweep labels; low coverage does not anchor', () => {
  const a = checkAnchors({
    when: '2026-07-02T10:00:00Z',
    days: [
      { label: 'Today', hours: 9, coverage: 0.9 },
      { label: 'Jun 21', hours: 8, coverage: 0.9 },
      { label: 'Mar / Sep 21', hours: 6, coverage: 0.8 },
      { label: 'Dec 21', hours: 1, coverage: 0.2 }, // skipped
    ],
  });
  assert.deepEqual(
    a.map((x) => x.month).sort((p, q) => p - q),
    [3, 6, 7, 9],
    'Jun, both equinoxes, and Today(July); December under-swept',
  );
});

test('residuals: exact at anchors, interpolated around the year circle', () => {
  // measured 4 h in June, 8 h in December against a flat 10 h model
  const res = monthlyResiduals([{ month: 6, hours: 4 }, { month: 12, hours: 8 }], FLAT10);
  approx(res[5], -6, 1e-9, 'June anchor exact');
  approx(res[11], -2, 1e-9, 'December anchor exact');
  approx(res[8], -4, 1e-9, 'September: halfway June→December');
  approx(res[2], -4, 1e-9, 'March: halfway December→June (wraps the year)');
  const single = monthlyResiduals([{ month: 6, hours: 4 }], FLAT10);
  approx(single[0], -6, 1e-9, 'single anchor: constant residual');
  approx(single[11], -6, 1e-9, 'single anchor: constant residual');
});

test('duplicate anchor months average', () => {
  const res = monthlyResiduals(
    [{ month: 6, hours: 4 }, { month: 6, hours: 6 }],
    FLAT10,
  );
  approx(res[5], -5, 1e-9, 'two June sightings mean');
});

test('no anchors → no correction', () => {
  const res = monthlyResiduals([], FLAT10);
  assert.ok(res.every((v) => v === 0));
  const idw = idwResidualAt(3, 4, []);
  assert.ok(idw.every((v) => v === 0));
});

test('IDW: near a pin its residual dominates; midpoint averages', () => {
  const mk = (v) => new Float64Array(12).fill(v);
  const spots = [
    { x: -8, y: 0, res: mk(-6) },
    { x: 8, y: 0, res: mk(2) },
  ];
  approx(idwResidualAt(-8, 0, spots)[0], -6, 0.05, 'on the shady pin');
  approx(idwResidualAt(8, 0, spots)[0], 2, 0.05, 'on the sunny pin');
  approx(idwResidualAt(0, 0, spots)[0], -2, 1e-9, 'midpoint: plain mean');
  assert.ok(idwResidualAt(-7, 0, spots)[0] < -5, 'close beats far');
});
