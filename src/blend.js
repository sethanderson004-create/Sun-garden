/**
 * Measured-spot blending: turn saved AR spot checks (ground truth measured
 * standing in the garden) into a correction field over the whole map, so the
 * regions a gardener sees are anchored to what they measured, not just to a
 * sketch. The model supplies the seasonal *shape* everywhere; measurements
 * pin the *level* near where they were taken:
 *
 *   corrected(cell, month) = model(cell, month) + IDW(residuals)(cell, month)
 *
 * where a spot's residual is (measured − model-at-that-spot), interpolated
 * across the 12 months from the sweep's measured days. With no obstacles
 * sketched the model is flat open sky and this reduces to pure interpolation
 * of the measurements; with a sketched yard it becomes a calibration layer.
 * Pure math — the UI supplies positions and model predictions.
 */

const MONTHS = 12;

/**
 * The comparable calendar months of one AR check's sweep rows (ar.js's day
 * labels). Low-coverage rows don't anchor: a sweep that skipped most of an
 * arc is a guess, not a measurement.
 */
export function checkAnchors(check, minCoverage = 0.4) {
  const out = [];
  for (const d of check.days || []) {
    if (!(d.coverage >= minCoverage) || !Number.isFinite(d.hours)) continue;
    if (d.label === 'Jun 21') out.push({ month: 6, hours: d.hours });
    else if (d.label === 'Dec 21') out.push({ month: 12, hours: d.hours });
    else if (d.label === 'Mar / Sep 21') {
      // capture-time foliage is unknown; anchor both equinoxes to the sweep
      out.push({ month: 3, hours: d.hours }, { month: 9, hours: d.hours });
    } else if (d.label === 'Today') {
      const m = new Date(check.when).getMonth() + 1;
      if (m >= 1 && m <= 12) out.push({ month: m, hours: d.hours });
    }
  }
  return out;
}

const circDist = (a, b) => Math.min(((a - b) + MONTHS) % MONTHS, ((b - a) + MONTHS) % MONTHS);

/**
 * Per-month residuals (measured − predicted) for one spot, interpolated
 * around the 12-month circle between the anchor months: exact at anchors,
 * distance-weighted between the two nearest on either side elsewhere, so a
 * "loses the winter sun" spot keeps that seasonal structure.
 */
export function monthlyResiduals(anchors, predicted12) {
  const res = new Float64Array(MONTHS);
  if (!anchors.length) return res;
  // collapse duplicate anchor months to their mean
  const byMonth = new Map();
  for (const a of anchors) {
    const r = a.hours - predicted12[a.month - 1];
    const cur = byMonth.get(a.month);
    byMonth.set(a.month, cur ? { r: (cur.r * cur.n + r) / (cur.n + 1), n: cur.n + 1 } : { r, n: 1 });
  }
  const pts = [...byMonth.entries()].map(([month, v]) => ({ month, r: v.r }));
  for (let m = 1; m <= MONTHS; m++) {
    const exact = pts.find((p) => p.month === m);
    if (exact) {
      res[m - 1] = exact.r;
      continue;
    }
    // nearest anchor clockwise and counter-clockwise around the year
    let next = null;
    let prev = null;
    for (const p of pts) {
      const fwd = ((p.month - m) + MONTHS) % MONTHS;
      const back = ((m - p.month) + MONTHS) % MONTHS;
      if (!next || fwd < next.d) next = { r: p.r, d: fwd };
      if (!prev || back < prev.d) prev = { r: p.r, d: back };
    }
    res[m - 1] = (prev.r * next.d + next.r * prev.d) / (prev.d + next.d);
  }
  return res;
}

/**
 * Inverse-distance-weighted blend of spot residuals at one point.
 * `spots`: [{ x, y, res: Float64Array(12) }]. The +1 m² in the weight keeps
 * a cell sitting on a pin finite and slightly smooths single-spot yards.
 */
export function idwResidualAt(x, y, spots) {
  const out = new Float64Array(MONTHS);
  if (!spots.length) return out;
  let wSum = 0;
  for (const s of spots) {
    const w = 1 / ((s.x - x) ** 2 + (s.y - y) ** 2 + 1);
    wSum += w;
    for (let m = 0; m < MONTHS; m++) out[m] += w * s.res[m];
  }
  for (let m = 0; m < MONTHS; m++) out[m] /= wSum;
  return out;
}
