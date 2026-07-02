/**
 * Whole-garden sun grid: evaluate a scene's sun hours over many points
 * cheaply enough to recompute a heatmap live while the user sketches.
 *
 * The trick: a garden spans meters while the sun's position varies over
 * kilometers, so one precomputed table of sun samples (12 months × the day's
 * 5-minute steps, ~1.7k daytime positions) serves every cell. Per cell the
 * work is only "build the skyline, compare each sample against it" — no
 * solar math in the inner loop. Results match sunHoursForDay exactly: same
 * dates (the 21st), same sampling window, same lit test.
 */

import { solarPosition, solarNoonUtcMs } from './solar.js?v=7'; // ?v= must match app.js — see cache-busting note there
import { skylineLayersForPoint, inLeaf } from './scene.js?v=7';

/**
 * Sun positions for the 21st of every month of `year` at (lat, lon), sampled
 * every `stepMinutes` across a 24 h window centered on solar noon (the
 * sunhours.js convention). Only above-horizon samples are kept — a skyline
 * can never unblock the ground — so each month carries its day length.
 */
export function sunSampleTable(lat, lon, year, stepMinutes = 5) {
  const months = [];
  for (let month = 1; month <= 12; month++) {
    const noon = solarNoonUtcMs(year, month, 21, lon);
    const samples = [];
    for (let m = -720; m < 720; m += stepMinutes) {
      const { azimuth, elevation } = solarPosition(lat, lon, noon + m * 60000);
      if (elevation > 0) samples.push({ azimuth, elevation });
    }
    // Packed twins of `samples` for the per-cell hot loop: elevation plus
    // the azimuth split into skyline bin index + interpolation fraction
    // (exactly layerAt's split, so fast and direct paths agree bit-for-bit).
    const n = samples.length;
    const el = new Float64Array(n);
    const bin = new Uint16Array(n);
    const frac = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = ((samples[k].azimuth % 360) + 360) % 360;
      el[k] = samples[k].elevation;
      bin[k] = Math.floor(a);
      frac[k] = a - bin[k];
    }
    months.push({ month, samples, el, bin, frac });
  }
  return { lat, lon, year, stepMinutes, months };
}

/**
 * Sun hours for each of the table's 12 months, for one point's skyline
 * layers. Returns a Float64Array(12) indexed by month−1.
 */
export function monthlyHoursForLayers(layers, table) {
  const { solid, leafy } = layers;
  const hours = new Float64Array(12);
  for (const { month, el, bin, frac } of table.months) {
    const leafOn = inLeaf(month, table.lat);
    let lit = 0;
    for (let k = 0; k < el.length; k++) {
      const i = bin[k];
      const j = (i + 1) % 360;
      const f = frac[k];
      let blocked = solid[i] * (1 - f) + solid[j] * f;
      if (leafOn) {
        const l = leafy[i] * (1 - f) + leafy[j] * f;
        if (l > blocked) blocked = l;
      }
      if (el[k] > blocked) lit++;
    }
    hours[month - 1] = (lit * table.stepMinutes) / 60;
  }
  return hours;
}

/**
 * The heatmap payload: monthly sun hours for every cell of a north-aligned
 * grid over the scene. `grid` is { x0, y0, cellSize, cols, rows } in scene
 * units; cell (col, row) is centered at (x0 + (col+0.5)·cellSize,
 * y0 + (row+0.5)·cellSize), so columns advance east and rows advance north.
 * Returns cells in row-major order: { x, y, col, row, hours }.
 */
export function sunHoursGrid(scene, grid, table, plantHeight = 0) {
  const cells = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const x = grid.x0 + (col + 0.5) * grid.cellSize;
      const y = grid.y0 + (row + 0.5) * grid.cellSize;
      const layers = skylineLayersForPoint(scene, x, y, plantHeight);
      cells.push({ x, y, col, row, hours: monthlyHoursForLayers(layers, table) });
    }
  }
  return cells;
}
