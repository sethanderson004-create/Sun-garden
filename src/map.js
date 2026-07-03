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

import { sunSampleTable, sunHoursGrid } from './sungrid.js?v=8';
import { blockedElevationAt, inLeaf } from './scene.js?v=8';
import { solarPosition, solarNoonUtcMs } from './solar.js?v=8';
import { categorize } from './sunhours.js?v=8';

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
  obstacles: [],
  month: new Date().getMonth() + 1,
  tool: 'select',
  selected: -1,
  movie: false,
  movieMin: 0, // minutes from solar noon
  bg: null, // background Image (never persisted)
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
    if (Array.isArray(saved.scene.obstacles)) state.obstacles = saved.scene.obstacles;
  }
}

function persist() {
  // Merge over the JSON as stored right now — app.js/ar.js own other keys.
  localStorage.setItem(
    'sun-garden',
    JSON.stringify({
      ...readSaved(),
      scene: { viewSize: state.viewSize, obstacles: state.obstacles },
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
const xPx = (x) => W / 2 + x * pxPerM();
const yPx = (y) => W / 2 - y * pxPerM();
const xOfPx = (px) => (px - W / 2) / pxPerM();
const yOfPx = (py) => (W / 2 - py) / pxPerM();

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
    x0: -state.viewSize / 2,
    y0: -state.viewSize / 2,
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

  if (state.bg) {
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
    ctx.globalAlpha = state.bg ? 0.55 : 0.8;
    if (state.movie) {
      const sun = movieSun();
      const leafOn = inLeaf(state.month, state.lat);
      const lit = cssVar('--cat-full-sun');
      const shade = cssVar('--cat-full-shade');
      for (const c of cells.list) {
        const up = sun.elevation > 0;
        const sunny = up && sun.elevation > blockedElevationAt(state.obstacles, c.x, c.y, sun.azimuth, leafOn);
        ctx.fillStyle = sunny ? lit : shade;
        ctx.globalAlpha = up ? (state.bg ? 0.55 : 0.8) : 0.9;
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

// ------------------------------------------------------------- gestures

function setTool(tool) {
  if (pending?.kind === 'polyline') finishFence();
  state.tool = tool;
  pending = null;
  document.querySelectorAll('.tool').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool));
  $('readout').textContent = {
    select: 'Tap an obstacle to edit or drag to move it; tap open ground to read that spot’s hours.',
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
  canvas.setPointerCapture(ev.pointerId);
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
    const hit = hitTest(pt);
    state.selected = hit;
    showEditPanel();
    if (hit >= 0) {
      pending = { kind: 'move', last: pt, moved: false };
    } else {
      const c = cellAt(pt.x, pt.y);
      if (c) {
        const h = c.hours[state.month - 1];
        $('readout').textContent =
          `${MONTHS[state.month - 1]} at this spot: ${h.toFixed(1)} h direct sun — ${categorize(h).name}.`;
      }
    }
    draw();
  }
});

canvas.addEventListener('pointermove', (ev) => {
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
  } else if (pending.kind === 'polyline') {
    pending.cursor = pt;
    draw();
  } else {
    pending.b = pt;
    draw();
  }
});

canvas.addEventListener('pointerup', () => {
  if (!pending) return;
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
  }
  // polyline pends across clicks until double-click
});

canvas.addEventListener('dblclick', (ev) => {
  ev.preventDefault();
  if (state.tool === 'fence') finishFence();
});

// --------------------------------------------------------- photo & clear

$('photoBtn').addEventListener('click', () => $('photoFile').click());
$('photoFile').addEventListener('change', () => {
  const file = $('photoFile').files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    state.bg = img;
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
};
