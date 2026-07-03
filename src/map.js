/**
 * Garden sun map UI: sketch the yard's shade-casters top-down and paint a
 * live sun-hours heatmap over the whole garden (PLAN.md Phase 2, M3).
 *
 * World model: scene.js coordinates — meters, x east, y north, origin at the
 * canvas center, north up. The canvas shows a square window `viewSize`
 * meters across; the 📏 scale tool rescales that by letting the user draw a
 * line over something of known length (essential when tracing a satellite
 * screenshot loaded with 🛰 Photo — the image is view-fitted, never stored).
 *
 * Heatmap: sunHoursGrid over an N×N grid of the view. Cells carry all 12
 * months, so the month slider only re-colors. Sketch edits recompute — a
 * coarse draft grid while dragging, the full grid on release. The shadow
 * movie bypasses the grid entirely: one blockedElevationAt ray per cell per
 * frame against the sun's instantaneous position.
 *
 * Storage-ownership rule (see CLAUDE.md): this page owns only the `scene`
 * key inside the shared "sun-garden" JSON and must merge over readSaved()
 * at write time; lat/lon belong to app.js and are read, never written.
 */

import { sunSampleTable, sunHoursGrid, monthlyHoursForLayers } from './sungrid.js?v=15';
import { skylineLayersForPoint, blockedElevationAt, inLeaf } from './scene.js?v=15';
import { solarPosition, solarNoonUtcMs } from './solar.js?v=15';
import { categorize } from './sunhours.js?v=15';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const CAT_VAR = {
  'Full sun': '--cat-full-sun',
  'Part sun': '--cat-part-sun',
  'Part shade': '--cat-part-shade',
  'Full shade': '--cat-full-shade',
};
const PRESETS = {
  building: [['1 story', 3.5], ['2 stories', 6.5], ['3 stories', 9.5]],
  tree: [['Small tree', 4], ['Medium tree', 8], ['Large tree', 14]],
  fence: [['Low fence', 1.2], ['Standard fence', 1.8], ['Tall hedge/wall', 2.4]],
};
const GRID_N = 48;
const DRAFT_N = 20;

// ---------------------------------------------------------------- state

const state = {
  lat: 47.6062,
  lon: -122.3321,
  viewSize: 40, // meters shown across the canvas
  viewCx: 0, // view-center offset from the lat/lon origin, meters east
  viewCy: 0, // …and north (drag open ground to pan)
  basemap: false, // satellite tiles under the sketch (opt-in — see satBtn)
  obstacles: [],
  month: new Date().getMonth() + 1,
  tool: 'select',
  selected: -1,
  movie: false,
  movieMin: 0, // minutes from solar noon
  bg: null, // background Image (never persisted)
  checks: [], // saved AR spot checks (owned by ar.js — read-only here)
  pins: {}, // user-corrected pin positions, keyed by check.when (ours, in scene)
  pinSel: null, // `when` of the selected pin
};
const year = new Date().getFullYear();

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem('sun-garden') || 'null') || {};
  } catch {
    return {};
  }
}

function loadSaved() {
  const saved = readSaved();
  if (Number.isFinite(saved.lat)) state.lat = saved.lat;
  if (Number.isFinite(saved.lon)) state.lon = saved.lon;
  if (saved.scene) {
    if (Number.isFinite(saved.scene.viewSize)) state.viewSize = saved.scene.viewSize;
    if (Number.isFinite(saved.scene.viewCx)) state.viewCx = saved.scene.viewCx;
    if (Number.isFinite(saved.scene.viewCy)) state.viewCy = saved.scene.viewCy;
    state.basemap = !!saved.scene.basemap;
    if (Array.isArray(saved.scene.obstacles)) state.obstacles = saved.scene.obstacles;
    if (saved.scene.pins && typeof saved.scene.pins === 'object') state.pins = saved.scene.pins;
  }
  state.checks = Array.isArray(saved.arChecks) ? saved.arChecks : [];
}

function persist() {
  // Merge over the JSON as stored right now — app.js/ar.js own other keys.
  localStorage.setItem(
    'sun-garden',
    JSON.stringify({
      ...readSaved(),
      scene: {
        viewSize: state.viewSize,
        viewCx: state.viewCx,
        viewCy: state.viewCy,
        basemap: state.basemap,
        obstacles: state.obstacles,
        pins: state.pins,
      },
    }),
  );
}

// ------------------------------------------------------- view transforms

let W = 0; // canvas pixels (square)
function resize() {
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 640;
  const dpr = window.devicePixelRatio || 1;
  W = Math.round(cssW * dpr);
  canvas.width = W;
  canvas.height = W;
  canvas.style.height = `${cssW}px`;
  draw();
}

const pxPerM = () => W / state.viewSize;
const xPx = (x) => W / 2 + (x - state.viewCx) * pxPerM();
const yPx = (y) => W / 2 - (y - state.viewCy) * pxPerM();
const xOfPx = (px) => state.viewCx + (px - W / 2) / pxPerM();
const yOfPx = (py) => state.viewCy + (W / 2 - py) / pxPerM();

function eventPoint(ev) {
  const r = canvas.getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * W;
  const py = ((ev.clientY - r.top) / r.height) * W;
  return { x: xOfPx(px), y: yOfPx(py) };
}

// ------------------------------------------------------------- sun grid

let table = null;
let cells = null; // { n, list } from sunHoursGrid
let recomputeTimer = 0;

function gridSpec(n) {
  return {
    x0: state.viewCx - state.viewSize / 2,
    y0: state.viewCy - state.viewSize / 2,
    cellSize: state.viewSize / n,
    cols: n,
    rows: n,
  };
}

function recompute(draft = false) {
  table ??= sunSampleTable(state.lat, state.lon, year);
  const n = draft ? DRAFT_N : GRID_N;
  cells = { n, list: sunHoursGrid(state.obstacles, gridSpec(n), table) };
  if (draft) {
    // settle to the full grid shortly after the interaction pauses
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => recompute(false), 250);
  }
  draw();
}

function cellAt(x, y) {
  if (!cells) return null;
  const g = gridSpec(cells.n);
  const col = Math.floor((x - g.x0) / g.cellSize);
  const row = Math.floor((y - g.y0) / g.cellSize);
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return null;
  return cells.list[row * g.cols + col];
}

// -------------------------------------------------- satellite basemap

// Esri World Imagery tiles drawn under the sketch, opt-in (loading them
// shares the user's approximate location with Esri — the confirm on satBtn
// says so). The point of using a real tile pyramid: scale is *derived*, not
// eyeballed. Web mercator ground resolution is a closed formula of latitude
// and zoom, and the view is anchored to the garden's lat/lon, so meters on
// the sketch and meters on the imagery agree automatically — no 📏 needed.

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const ESRI_ATTRIBUTION = 'Imagery: Esri, Maxar, Earthstar Geographics';
const EQUATOR_RES = 156543.03392; // m per tile px at zoom 0 (256px tiles)
const RAD = Math.PI / 180;

const tileCache = new Map(); // "z/x/y" → { img, ok }
let maxTileZoom = 23; // the service's max LOD; lowered when a level 404s here
let lastTileZoom = 0; // what drawBasemap actually used (debug/tests)

function groundRes(z) {
  return (EQUATOR_RES * Math.cos(state.lat * RAD)) / 2 ** z;
}

/** Web-mercator pixel of (lat, lon) in the zoom-z world image. */
function worldPx(lat, lon, z) {
  const n = 256 * 2 ** z;
  const rad = lat * RAD;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

// Beyond its real imagery Esri sometimes 404s and sometimes serves flat
// placeholder tiles with HTTP 200 (both field-observed). But a flat tile
// alone proves nothing — zoomed in over a yard, *real* tiles are flat too
// (lawn, asphalt, a big roof; field-observed false positive that blanked
// the map). So flat tiles are held provisional and judged against the SAME
// SPOT in the nearest loaded ancestor: texture there means detail should
// exist (placeholder → fall back), flat there too means featureless ground
// (real → keep). Only confirmed placeholders count toward stepping the
// whole level down.
const blankCountAt = {};
let probeCtx = null;
const FLAT_SPREAD = 12; // summed per-channel spread below this = featureless

/** Per-channel color spread of an image region, via an 8×8 downsample. */
function spreadOf(img, sx, sy, sw, sh) {
  if (!probeCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    probeCtx = c.getContext('2d', { willReadFrequently: true });
  }
  probeCtx.drawImage(img, sx, sy, sw, sh, 0, 0, 8, 8);
  const d = probeCtx.getImageData(0, 0, 8, 8).data;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      if (d[i + ch] < min[ch]) min[ch] = d[i + ch];
      if (d[i + ch] > max[ch]) max[ch] = d[i + ch];
    }
  }
  return max[0] - min[0] + (max[1] - min[1]) + (max[2] - min[2]);
}

function tileMissing(t, z) {
  t.ok = false;
  blankCountAt[z] = (blankCountAt[z] || 0) + 1;
  if (z > 15 && maxTileZoom >= z && blankCountAt[z] >= 3) maxTileZoom = z - 1;
}

/** Decide a provisionally-flat tile once an ancestor is available. */
function resolveFlatTile(t, z, x, y) {
  for (let up = 1; up <= 7 && z - up >= 3; up++) {
    const anc = tileCache.get(`${z - up}/${x >> up}/${y >> up}`);
    if (anc?.ok) {
      const frac = 256 / 2 ** up;
      let ancSpread = 0;
      try {
        ancSpread = spreadOf(anc.img, (x % 2 ** up) * frac, (y % 2 ** up) * frac, frac, frac);
      } catch {}
      t.pendingFlat = false;
      if (ancSpread >= FLAT_SPREAD) tileMissing(t, z); // placeholder confirmed
      else t.ok = true; // featureless ground all the way down — real imagery
      return;
    }
  }
  // no ancestor loaded yet: keep showing the fallback, decide on a later draw
}

function tileFor(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let t = tileCache.get(key);
  if (!t) {
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
    t = { img: new Image(), ok: false };
    t.img.crossOrigin = 'anonymous';
    t.img.onload = () => {
      t.ok = true;
      // placeholders only exist past the real imagery, so probe close-in
      // levels only — wide views legitimately contain uniform tiles
      let flat = false;
      if (z >= 18) {
        try {
          flat = spreadOf(t.img, 0, 0, t.img.width, t.img.height) < FLAT_SPREAD;
        } catch {} // tainted canvas (no CORS) — assume real imagery
      }
      if (flat) {
        t.ok = false;
        t.pendingFlat = true;
      }
      draw();
    };
    t.img.onerror = () => {
      tileMissing(t, z);
      draw();
    };
    t.img.src = TILE_URL(z, x, y);
    tileCache.set(key, t);
  }
  return t;
}

function drawBasemap() {
  const wantRes = state.viewSize / W; // meters per canvas px
  lastTileZoom = Math.max(
    3,
    Math.min(maxTileZoom, Math.ceil(Math.log2((EQUATOR_RES * Math.cos(state.lat * RAD)) / wantRes))),
  );
  const z = lastTileZoom;
  const gr = groundRes(z);
  const s = gr / wantRes; // canvas px per tile px
  const origin = worldPx(state.lat, state.lon, z);
  // world px at the canvas top-left (view center = origin + pan offset)
  const x0 = origin.x + state.viewCx / gr - W / 2 / s;
  const y0 = origin.y - state.viewCy / gr - W / 2 / s;
  const n = 2 ** z;
  for (let tx = Math.floor(x0 / 256); tx * 256 < x0 + W / s; tx++) {
    for (let ty = Math.max(0, Math.floor(y0 / 256)); ty * 256 < y0 + W / s && ty < n; ty++) {
      // +0.6 px bleed hides hairline seams between scaled tiles
      drawTileSlot(z, ((tx % n) + n) % n, ty, (tx * 256 - x0) * s, (ty * 256 - y0) * s, 256 * s + 0.6);
    }
  }
  // a level demoted mid-pass (placeholders confirmed) needs one more pass
  if (z > maxTileZoom) requestAnimationFrame(draw);
}

/**
 * Draw one tile slot; while the exact tile is missing (still loading, or
 * sharper than anything published for this area) draw the matching quarter
 * of the nearest available ancestor scaled up instead. Close-in planning
 * zooms past Esri's max imagery level in most neighborhoods — the picture
 * must go soft there, never blank.
 */
function drawTileSlot(z, x, y, dx, dy, dSize) {
  const t = tileFor(z, x, y);
  if (t.pendingFlat) resolveFlatTile(t, z, x, y);
  if (t.ok) {
    ctx.drawImage(t.img, dx, dy, dSize, dSize);
    return;
  }
  for (let up = 1; up <= 7 && z - up >= 3; up++) {
    const anc = tileFor(z - up, x >> up, y >> up);
    if (anc.ok) {
      const frac = 256 / 2 ** up;
      ctx.drawImage(anc.img, (x % 2 ** up) * frac, (y % 2 ** up) * frac, frac, frac, dx, dy, dSize, dSize);
      return;
    }
  }
}

// ---------------------------------------------------- AR spot-check pins

// A saved AR sweep is ground truth measured while standing in the garden;
// the sketch is a model. Each check becomes a pin showing measured vs
// predicted hours — agreement means the sketch can be trusted everywhere,
// a mismatch says "something near here is drawn wrong". GPS places the pin
// initially (only good to a few meters), dragging corrects it; corrections
// live in scene.pins keyed by the check's `when` (arChecks itself belongs
// to ar.js and is never written here).

const M_PER_DEG = 110574; // meters per degree of latitude (lon scales by cos)
const PIN_TOL_H = 1.25; // measured-vs-predicted agreement threshold, hours
const MIN_COVERAGE = 0.4; // sweeps that skipped most of an arc don't judge

function pinPos(check) {
  const fixed = state.pins[check.when];
  if (fixed && Number.isFinite(fixed.x) && Number.isFinite(fixed.y)) return fixed;
  return {
    x: (check.lon - state.lon) * M_PER_DEG * Math.cos((state.lat * Math.PI) / 180),
    y: (check.lat - state.lat) * M_PER_DEG,
  };
}

/** Months a sweep-day label is comparable against (ar.js's day set). */
function labelMonths(label, when) {
  if (label === 'Jun 21') return [6];
  if (label === 'Dec 21') return [12];
  if (label === 'Mar / Sep 21') return [3, 9]; // foliage at capture unknown — either may match
  if (label === 'Today') {
    const m = new Date(when).getMonth() + 1;
    return Number.isFinite(m) ? [m] : [];
  }
  return [];
}

/** Measured-vs-predicted rows for one check at its pin position. */
function pinVerdict(check) {
  table ??= sunSampleTable(state.lat, state.lon, year);
  const pos = pinPos(check);
  const predicted = monthlyHoursForLayers(
    skylineLayersForPoint(state.obstacles, pos.x, pos.y),
    table,
  );
  const rows = [];
  for (const d of check.days || []) {
    if (d.coverage < MIN_COVERAGE) continue;
    const months = labelMonths(d.label, check.when);
    if (!months.length) continue;
    // compare against the closest candidate month (equinox label spans two)
    const model = months
      .map((m) => predicted[m - 1])
      .reduce((a, b) => (Math.abs(b - d.hours) < Math.abs(a - d.hours) ? b : a));
    rows.push({ label: d.label, measured: d.hours, predicted: model, delta: model - d.hours });
  }
  return { pos, rows, ok: rows.length > 0 && rows.every((r) => Math.abs(r.delta) <= PIN_TOL_H) };
}

function drawPins() {
  for (const check of state.checks) {
    const v = pinVerdict(check);
    const px = xPx(v.pos.x);
    const py = yPx(v.pos.y);
    const r = Math.max(6, W / 110);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = cssVar(v.rows.length ? (v.ok ? '--path-equinox' : '--path-today') : '--text-muted');
    ctx.fill();
    ctx.lineWidth = Math.max(2, W / 400);
    ctx.strokeStyle = check.when === state.pinSel ? cssVar('--accent') : cssVar('--surface-1');
    ctx.stroke();
    ctx.fillStyle = cssVar('--text-primary');
    ctx.font = `600 ${Math.max(10, W / 60)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${v.ok || !v.rows.length ? '☀' : '≠'} ${check.name}`, px, py - r - 5);
  }
}

function describePin(check) {
  const v = pinVerdict(check);
  if (!v.rows.length) {
    $('readout').textContent = `“${check.name}”: sweep coverage too low to compare. Drag the pin to where you stood.`;
    return;
  }
  const parts = v.rows.map(
    (r) => `${r.label}: measured ${r.measured.toFixed(1)} h, sketch says ${r.predicted.toFixed(1)} h`,
  );
  $('readout').textContent = v.ok
    ? `“${check.name}” agrees with the sketch ✓ — ${parts.join(' · ')}.`
    : `“${check.name}” disagrees — ${parts.join(' · ')}. Drag the pin to where you stood, or fix nearby heights until they match.`;
}

// ------------------------------------------------------------- drawing

let pending = null; // in-progress gesture (per tool)

function drawObstacle(ob, selected) {
  ctx.lineWidth = Math.max(1.5, W / 480);
  if (ob.type === 'building') {
    ctx.beginPath();
    ob.footprint.forEach((p, i) => (i ? ctx.lineTo(xPx(p.x), yPx(p.y)) : ctx.moveTo(xPx(p.x), yPx(p.y))));
    ctx.closePath();
    ctx.fillStyle = cssVar('--skyline-fill');
    ctx.fill();
    ctx.strokeStyle = selected ? cssVar('--accent') : cssVar('--skyline-edge');
    ctx.stroke();
  } else if (ob.type === 'fence') {
    ctx.beginPath();
    ob.points.forEach((p, i) => (i ? ctx.lineTo(xPx(p.x), yPx(p.y)) : ctx.moveTo(xPx(p.x), yPx(p.y))));
    ctx.strokeStyle = selected ? cssVar('--accent') : cssVar('--skyline-edge');
    ctx.lineWidth = Math.max(3, W / 240);
    ctx.stroke();
  } else if (ob.type === 'tree') {
    const r = (ob.crownWidth / 2) * pxPerM();
    ctx.beginPath();
    ctx.arc(xPx(ob.x), yPx(ob.y), r, 0, Math.PI * 2);
    ctx.fillStyle = ob.deciduous ? cssVar('--leafy-fill') : cssVar('--skyline-fill');
    ctx.fill();
    ctx.strokeStyle = selected
      ? cssVar('--accent')
      : ob.deciduous ? cssVar('--leafy-edge') : cssVar('--skyline-edge');
    if (ob.deciduous) ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(xPx(ob.x), yPx(ob.y), Math.max(2, W / 320), 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--skyline-edge');
    ctx.fill();
  }
}

function movieSun() {
  const noon = solarNoonUtcMs(year, state.month, 21, state.lon);
  return solarPosition(state.lat, state.lon, noon + state.movieMin * 60000);
}

function draw() {
  if (!W) return;
  ctx.clearRect(0, 0, W, W);

  if (state.basemap) {
    drawBasemap();
  } else if (state.bg) {
    // view-fit (cover) the screenshot; the scale tool calibrates viewSize
    const s = Math.max(W / state.bg.width, W / state.bg.height);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(
      state.bg,
      W / 2 - (state.bg.width * s) / 2,
      W / 2 - (state.bg.height * s) / 2,
      state.bg.width * s,
      state.bg.height * s,
    );
    ctx.globalAlpha = 1;
  }

  // heatmap
  if (cells) {
    const g = gridSpec(cells.n);
    const cw = g.cellSize * pxPerM();
    // over imagery the tint must whisper, not shout — the photo is the map
    const overImagery = state.bg || state.basemap;
    ctx.globalAlpha = overImagery ? 0.38 : 0.8;
    if (state.movie) {
      const sun = movieSun();
      const leafOn = inLeaf(state.month, state.lat);
      const lit = cssVar('--cat-full-sun');
      const shade = cssVar('--cat-full-shade');
      for (const c of cells.list) {
        const up = sun.elevation > 0;
        const sunny = up && sun.elevation > blockedElevationAt(state.obstacles, c.x, c.y, sun.azimuth, leafOn);
        ctx.fillStyle = sunny ? lit : shade;
        ctx.globalAlpha = up ? (overImagery ? 0.38 : 0.8) : 0.9;
        ctx.fillRect(xPx(c.x) - cw / 2, yPx(c.y) - cw / 2, cw + 0.5, cw + 0.5);
      }
    } else {
      for (const c of cells.list) {
        const cat = categorize(c.hours[state.month - 1]);
        ctx.fillStyle = cssVar(CAT_VAR[cat.name]);
        ctx.fillRect(xPx(c.x) - cw / 2, yPx(c.y) - cw / 2, cw + 0.5, cw + 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  state.obstacles.forEach((ob, i) => drawObstacle(ob, i === state.selected));
  drawPins();

  // pending gesture previews
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = Math.max(1.5, W / 480);
  ctx.setLineDash([6, 4]);
  if (pending?.kind === 'rect') {
    ctx.strokeRect(
      Math.min(xPx(pending.a.x), xPx(pending.b.x)),
      Math.min(yPx(pending.a.y), yPx(pending.b.y)),
      Math.abs(xPx(pending.b.x) - xPx(pending.a.x)),
      Math.abs(yPx(pending.b.y) - yPx(pending.a.y)),
    );
  } else if (pending?.kind === 'circle') {
    ctx.beginPath();
    ctx.arc(xPx(pending.a.x), yPx(pending.a.y), Math.hypot(pending.b.x - pending.a.x, pending.b.y - pending.a.y) * pxPerM(), 0, Math.PI * 2);
    ctx.stroke();
  } else if (pending?.kind === 'line') {
    ctx.beginPath();
    ctx.moveTo(xPx(pending.a.x), yPx(pending.a.y));
    ctx.lineTo(xPx(pending.b.x), yPx(pending.b.y));
    ctx.stroke();
  } else if (pending?.kind === 'polyline') {
    ctx.beginPath();
    pending.points.forEach((p, i) => (i ? ctx.lineTo(xPx(p.x), yPx(p.y)) : ctx.moveTo(xPx(p.x), yPx(p.y))));
    if (pending.cursor) ctx.lineTo(xPx(pending.cursor.x), yPx(pending.cursor.y));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // north arrow + scale bar
  ctx.fillStyle = cssVar('--text-secondary');
  ctx.font = `${Math.max(11, W / 46)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('N ↑', W - W / 18, W / 14);
  const barM = state.viewSize >= 60 ? 10 : 5;
  const barPx = barM * pxPerM();
  ctx.strokeStyle = cssVar('--text-secondary');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 24, W - W / 24);
  ctx.lineTo(W / 24 + barPx, W - W / 24);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillText(`${barM} m`, W / 24, W - W / 24 - 6);

  if (state.basemap) {
    ctx.font = `${Math.max(9, W / 70)}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeText(ESRI_ATTRIBUTION, W - 8, W - 8);
    ctx.fillStyle = '#fff';
    ctx.fillText(ESRI_ATTRIBUTION, W - 8, W - 8);
  }
}

// ---------------------------------------------------------- hit testing

function hitTest(pt) {
  const tol = (12 / (canvas.clientWidth || 640)) * state.viewSize;
  for (let i = state.obstacles.length - 1; i >= 0; i--) {
    const ob = state.obstacles[i];
    if (ob.type === 'tree') {
      if (Math.hypot(ob.x - pt.x, ob.y - pt.y) <= Math.max(ob.crownWidth / 2, tol)) return i;
    } else if (ob.type === 'building') {
      const xs = ob.footprint.map((p) => p.x);
      const ys = ob.footprint.map((p) => p.y);
      if (pt.x >= Math.min(...xs) - tol && pt.x <= Math.max(...xs) + tol &&
          pt.y >= Math.min(...ys) - tol && pt.y <= Math.max(...ys) + tol) return i;
    } else if (ob.type === 'fence') {
      for (let s = 0; s < ob.points.length - 1; s++) {
        if (distToSegment(pt, ob.points[s], ob.points[s + 1]) <= tol) return i;
      }
    }
  }
  return -1;
}

function distToSegment(p, a, b) {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len2 = ex * ex + ey * ey || 1e-12;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2));
  return Math.hypot(p.x - (a.x + t * ex), p.y - (a.y + t * ey));
}

function translateObstacle(ob, dx, dy) {
  if (ob.type === 'tree') {
    ob.x += dx;
    ob.y += dy;
  } else {
    for (const p of ob.type === 'building' ? ob.footprint : ob.points) {
      p.x += dx;
      p.y += dy;
    }
  }
}

// ------------------------------------------------------------ edit panel

function showEditPanel() {
  const ob = state.obstacles[state.selected];
  const panel = $('editPanel');
  if (!ob) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block'; // the stylesheet default is display:none
  $('editTitle').textContent = { building: '🏠 Building', tree: '🌳 Tree', fence: '🚧 Fence' }[ob.type];
  const presets = PRESETS[ob.type];
  $('editPreset').innerHTML =
    '<option value="">custom…</option>' +
    presets.map(([name, h]) => `<option value="${h}">${name} (${h} m)</option>`).join('');
  $('editPreset').value = presets.some(([, h]) => h === ob.height) ? String(ob.height) : '';
  $('editHeight').value = ob.height;
  $('crownField').style.display = ob.type === 'tree' ? '' : 'none';
  $('leafField').style.display = ob.type === 'tree' ? '' : 'none';
  if (ob.type === 'tree') {
    $('editCrown').value = ob.crownWidth;
    $('editDeciduous').checked = !!ob.deciduous;
  }
}

function applyEdit() {
  const ob = state.obstacles[state.selected];
  if (!ob) return;
  const h = parseFloat($('editHeight').value);
  if (Number.isFinite(h) && h > 0) ob.height = h;
  if (ob.type === 'tree') {
    const c = parseFloat($('editCrown').value);
    if (Number.isFinite(c) && c > 0) ob.crownWidth = c;
    ob.deciduous = $('editDeciduous').checked;
  }
  persist();
  recompute();
}

$('editPreset').addEventListener('change', () => {
  if ($('editPreset').value) {
    $('editHeight').value = $('editPreset').value;
    applyEdit();
  }
});
$('editHeight').addEventListener('change', applyEdit);
$('editCrown').addEventListener('change', applyEdit);
$('editDeciduous').addEventListener('change', applyEdit);
$('deleteBtn').addEventListener('click', () => {
  if (state.selected < 0) return;
  state.obstacles.splice(state.selected, 1);
  state.selected = -1;
  showEditPanel();
  persist();
  recompute();
});

// ---------------------------------------------- pinch / wheel navigation

// Phone planning reality: you draw zoomed-in, so navigation must work in
// every tool — one finger draws, two fingers pinch-zoom and pan. A pinch
// interrupts whatever one-finger gesture was in flight (an in-progress
// fence polyline is stashed and resumed).

const pointers = new Map(); // active pointerId → client {x, y}
let fenceStash = null;

function clientToCanvasPx(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return { px: ((cx - r.left) / r.width) * W, py: ((cy - r.top) / r.height) * W };
}

/** Re-center so world point w sits at canvas pixel (px, py). */
function anchorWorldAt(w, px, py) {
  state.viewCx = w.x - (px - W / 2) / pxPerM();
  state.viewCy = w.y + (py - W / 2) / pxPerM();
}

function beginPinch() {
  if (pending?.kind === 'polyline') fenceStash = pending;
  else if (pending?.moved) persist(); // half-finished obstacle/pin drag
  const [a, b] = [...pointers.values()];
  const { px, py } = clientToCanvasPx((a.x + b.x) / 2, (a.y + b.y) / 2);
  pending = {
    kind: 'pinch',
    d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    vs0: state.viewSize,
    w0: { x: xOfPx(px), y: yOfPx(py) },
  };
}

function movePinch() {
  const [a, b] = [...pointers.values()];
  const d1 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  state.viewSize = Math.min(300, Math.max(5, pending.vs0 * (pending.d0 / d1)));
  // keep the ground that was between the fingers under them
  const { px, py } = clientToCanvasPx((a.x + b.x) / 2, (a.y + b.y) / 2);
  anchorWorldAt(pending.w0, px, py);
  recompute(true);
}

canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const { px, py } = clientToCanvasPx(ev.clientX, ev.clientY);
    const w = { x: xOfPx(px), y: yOfPx(py) };
    state.viewSize = Math.min(300, Math.max(5, state.viewSize * (ev.deltaY > 0 ? 1.15 : 1 / 1.15)));
    anchorWorldAt(w, px, py); // zoom about the cursor
    persist();
    recompute(true);
  },
  { passive: false },
);

// ------------------------------------------------------------- gestures

function setTool(tool) {
  if (pending?.kind === 'polyline') finishFence();
  state.tool = tool;
  pending = null;
  document.querySelectorAll('.tool').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool));
  $('readout').textContent = {
    select: 'Tap an obstacle to edit or drag to move it; tap open ground for that spot’s hours, drag it to pan (➕/➖ zoom, 🌍 satellite underlay).',
    building: 'Drag a rectangle over the building.',
    tree: 'Press on the trunk and drag out to the edge of the crown.',
    fence: 'Click corner to corner along the fence; double-click to finish.',
    scale: 'Drag a line over something you know the length of (a fence, the house wall).',
  }[tool];
  draw();
}
document.querySelectorAll('.tool').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));

function addObstacle(ob) {
  state.obstacles.push(ob);
  state.selected = state.obstacles.length - 1;
  showEditPanel();
  persist();
  recompute();
}

function finishFence() {
  const pts = pending?.points || [];
  pending = null;
  // drop the duplicate point the double-click's second press leaves behind
  const clean = pts.filter((p, i) => !i || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.15);
  if (clean.length >= 2) addObstacle({ type: 'fence', points: clean, height: 1.8 });
  else draw();
}

canvas.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {} // synthetic events (tests) have no real pointer to capture
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) {
    beginPinch();
    return;
  }
  if (pointers.size > 2 || pending?.kind === 'pinch') return;
  const pt = eventPoint(ev);
  if (state.tool === 'building') pending = { kind: 'rect', a: pt, b: pt };
  else if (state.tool === 'tree') pending = { kind: 'circle', a: pt, b: pt };
  else if (state.tool === 'scale') pending = { kind: 'line', a: pt, b: pt };
  else if (state.tool === 'fence') {
    if (!pending) pending = { kind: 'polyline', points: [] };
    pending.points.push(pt);
    pending.cursor = pt;
    draw();
  } else if (state.tool === 'select') {
    // pins sit on top of everything, so try them first
    const tol = (14 / (canvas.clientWidth || 640)) * state.viewSize;
    const pin = state.checks.find((c) => {
      const p = pinPos(c);
      return Math.hypot(p.x - pt.x, p.y - pt.y) <= tol;
    });
    if (pin) {
      state.pinSel = pin.when;
      state.selected = -1;
      showEditPanel();
      describePin(pin);
      pending = { kind: 'movepin', when: pin.when, moved: false };
      draw();
      return;
    }
    state.pinSel = null;
    const hit = hitTest(pt);
    state.selected = hit;
    showEditPanel();
    if (hit >= 0) {
      pending = { kind: 'move', last: pt, moved: false };
    } else {
      // open ground: a drag pans the view, a plain tap reads out the spot
      pending = {
        kind: 'pan',
        cx: ev.clientX, cy: ev.clientY,
        startCx: ev.clientX, startCy: ev.clientY,
        pt, moved: false,
      };
    }
    draw();
  }
});

canvas.addEventListener('pointermove', (ev) => {
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pending?.kind === 'pinch') {
    if (pointers.size >= 2) movePinch();
    return;
  }
  if (!pending) return;
  const pt = eventPoint(ev);
  if (pending.kind === 'move') {
    const ob = state.obstacles[state.selected];
    if (ob) {
      translateObstacle(ob, pt.x - pending.last.x, pt.y - pending.last.y);
      pending.last = pt;
      pending.moved = true;
      recompute(true);
    }
  } else if (pending.kind === 'movepin') {
    state.pins[pending.when] = { x: pt.x, y: pt.y };
    pending.moved = true;
    draw();
  } else if (pending.kind === 'pan') {
    if (!pending.moved &&
        Math.hypot(ev.clientX - pending.startCx, ev.clientY - pending.startCy) < 5) return;
    pending.moved = true;
    // client-px deltas → meters, so the ground tracks the finger exactly
    const r = canvas.getBoundingClientRect();
    const toM = (W / r.width) / pxPerM();
    state.viewCx -= (ev.clientX - pending.cx) * toM;
    state.viewCy += (ev.clientY - pending.cy) * toM;
    pending.cx = ev.clientX;
    pending.cy = ev.clientY;
    recompute(true);
  } else if (pending.kind === 'polyline') {
    pending.cursor = pt;
    draw();
  } else {
    pending.b = pt;
    draw();
  }
});

canvas.addEventListener('pointercancel', (ev) => {
  pointers.delete(ev.pointerId);
  if (pending?.kind === 'pinch') {
    if (pointers.size < 2) endPinch();
  } else if (pending && pending.kind !== 'polyline') {
    pending = null;
    draw();
  }
});

function endPinch() {
  pending = fenceStash; // resume an interrupted fence, or null
  fenceStash = null;
  persist();
  recompute();
}

canvas.addEventListener('pointerup', (ev) => {
  pointers.delete(ev.pointerId);
  if (!pending) return;
  if (pending.kind === 'pinch') {
    if (pointers.size < 2) endPinch();
    return;
  }
  if (pending.kind === 'rect') {
    const { a, b } = pending;
    pending = null;
    if (Math.abs(b.x - a.x) > 0.5 && Math.abs(b.y - a.y) > 0.5) {
      addObstacle({
        type: 'building',
        footprint: [
          { x: a.x, y: a.y }, { x: b.x, y: a.y },
          { x: b.x, y: b.y }, { x: a.x, y: b.y },
        ],
        height: 6.5,
      });
    } else draw();
  } else if (pending.kind === 'circle') {
    const { a, b } = pending;
    pending = null;
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    addObstacle({
      type: 'tree',
      x: a.x,
      y: a.y,
      height: 8,
      crownWidth: Math.max(2, r * 2),
      deciduous: false,
    });
  } else if (pending.kind === 'line') {
    const { a, b } = pending;
    pending = null;
    const drawn = Math.hypot(b.x - a.x, b.y - a.y);
    const answer = drawn > 0.2 && prompt('How long is that line in real life, in meters?');
    const real = parseFloat(answer);
    if (Number.isFinite(real) && real > 0) {
      state.viewSize *= real / drawn;
      persist();
      recompute();
      $('readout').textContent = `Scale set: the view is now ${state.viewSize.toFixed(0)} m across.`;
    } else draw();
  } else if (pending.kind === 'move') {
    if (pending.moved) {
      persist();
      recompute();
    }
    pending = null;
  } else if (pending.kind === 'movepin') {
    if (pending.moved) {
      persist();
      describePin(state.checks.find((c) => c.when === pending.when));
      draw();
    }
    pending = null;
  } else if (pending.kind === 'pan') {
    if (pending.moved) {
      persist();
      recompute();
    } else {
      const c = cellAt(pending.pt.x, pending.pt.y);
      if (c) {
        const h = c.hours[state.month - 1];
        $('readout').textContent =
          `${MONTHS[state.month - 1]} at this spot: ${h.toFixed(1)} h direct sun — ${categorize(h).name}.`;
      }
    }
    pending = null;
  }
  // polyline pends across clicks until double-click
});

canvas.addEventListener('dblclick', (ev) => {
  ev.preventDefault();
  if (state.tool === 'fence') finishFence();
});

// ------------------------------------------------- satellite & zoom UI

function updateSatUi() {
  $('satBtn').classList.toggle('active', state.basemap);
  const scaleBtn = document.querySelector('[data-tool="scale"]');
  scaleBtn.disabled = state.basemap;
  scaleBtn.title = state.basemap
    ? 'Scale comes from the satellite imagery automatically'
    : 'Drag a line over something you know the length of';
  if (state.basemap && state.tool === 'scale') setTool('select');
}

$('satBtn').addEventListener('click', () => {
  if (!state.basemap) {
    if (!confirm(
      'Show satellite imagery under your sketch?\n\n' +
      'Tiles are loaded from Esri (arcgisonline.com), so your approximate ' +
      'location is shared with that service. The imagery scale is exact — ' +
      'no 📏 calibration needed — but photos can be a few years old.',
    )) return;
    state.basemap = true;
    state.bg = null; // the screenshot underlay and live tiles don't stack
  } else {
    state.basemap = false;
  }
  updateSatUi();
  persist();
  draw();
});

function zoomBy(factor) {
  state.viewSize = Math.min(300, Math.max(5, state.viewSize * factor));
  persist();
  recompute();
}
$('zoomInBtn').addEventListener('click', () => zoomBy(1 / 1.3));
$('zoomOutBtn').addEventListener('click', () => zoomBy(1.3));

// --------------------------------------------------------- photo & clear

$('photoBtn').addEventListener('click', () => $('photoFile').click());
$('photoFile').addEventListener('change', () => {
  const file = $('photoFile').files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    state.bg = img;
    if (state.basemap) {
      state.basemap = false;
      updateSatUi();
      persist();
    }
    URL.revokeObjectURL(img.src);
    setTool('scale');
    $('readout').textContent =
      'Photo loaded (kept only until you leave the page). Now drag the 📏 scale line over something with a known length.';
    draw();
  };
  img.src = URL.createObjectURL(file);
});

$('clearBtn').addEventListener('click', () => {
  if (!state.obstacles.length || confirm('Remove every sketched obstacle?')) {
    state.obstacles = [];
    state.selected = -1;
    showEditPanel();
    persist();
    recompute();
  }
});

// --------------------------------------------------------------- sliders

function updateMonthOut() {
  $('monthOut').textContent = MONTHS[state.month - 1];
}
$('monthSlider').addEventListener('input', () => {
  state.month = Number($('monthSlider').value);
  updateMonthOut();
  draw();
});

function updateTimeOut() {
  const total = 12 * 60 + state.movieMin;
  const hh = Math.floor(total / 60);
  const mm = String(total % 60).padStart(2, '0');
  $('timeOut').textContent = `${hh}:${mm} solar`;
}
$('movieToggle').addEventListener('change', () => {
  state.movie = $('movieToggle').checked;
  $('timeSlider').disabled = !state.movie;
  draw();
});
$('timeSlider').addEventListener('input', () => {
  state.movieMin = Number($('timeSlider').value);
  updateTimeOut();
  draw();
});

// ------------------------------------------------------------------ boot

loadSaved();
$('monthSlider').value = state.month;
updateMonthOut();
updateTimeOut();
$('locLabel').textContent = `📍 ${state.lat.toFixed(3)}, ${state.lon.toFixed(3)} (set on the tracer page)`;
updateSatUi();
setTool(state.obstacles.length ? 'select' : 'building');
recompute();
resize();
window.addEventListener('resize', resize);

// Returning via the back-forward cache: pick up whatever app.js/ar.js wrote.
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) {
    loadSaved();
    table = null; // lat/lon may have changed
    recompute();
  }
});

// Playwright/debug hook, same idea as ar.js's __arDebug.
window.__mapDebug = {
  state,
  cellAt,
  recompute,
  setTool,
  hoursAt: (x, y) => cellAt(x, y)?.hours[state.month - 1],
  pinVerdict: (i) => {
    const { pos, rows, ok } = pinVerdict(state.checks[i]);
    return { pos, ok, rows };
  },
  basemap: () => ({ z: lastTileZoom, tiles: [...tileCache.keys()] }),
  worldPx,
};
