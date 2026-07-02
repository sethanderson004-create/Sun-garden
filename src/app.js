/**
 * Sun-Garden prototype UI: per-spot skyline tracing + monthly sun-hours
 * report, daily sun timeline, and spot comparison.
 *
 * Each spot (fence bed, veggie patch, porch…) carries its own skyline,
 * because the same tree fills a different share of the sky from each
 * viewpoint. A skyline has two layers: solid obstructions (buildings,
 * fences, evergreens) and deciduous trees, which only block during the
 * leaf-on months for the hemisphere.
 */

import { solarPosition } from './solar.js';
import {
  sunHoursForDay,
  sunPathForDay,
  sunIntervalsForDay,
  monthlyReport,
  categorize,
} from './sunhours.js';
import { fenceProfile, treeProfile, paintProfile } from './obstacles.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AZ_STEPS = 360; // skyline resolution: 1° bins
const MAX_EL = 90;

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

// ---------------------------------------------------------------- state

function makeSpot(name) {
  return { name, solid: new Float64Array(AZ_STEPS), leafy: new Float64Array(AZ_STEPS) };
}

const state = {
  lat: 47.6062,
  lon: -122.3321,
  spots: [makeSpot('Spot 1')],
  active: 0,
  brush: 'solid',
  timelineMonth: new Date().getMonth() + 1,
  photo: null, // HTMLImageElement or null
};

const activeSpot = () => state.spots[state.active];

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem('sun-garden') || 'null');
    if (!saved) return;
    if (Number.isFinite(saved.lat)) state.lat = saved.lat;
    if (Number.isFinite(saved.lon)) state.lon = saved.lon;
    if (Array.isArray(saved.spots) && saved.spots.length) {
      state.spots = saved.spots.map((s, i) => {
        const spot = makeSpot(typeof s.name === 'string' ? s.name : `Spot ${i + 1}`);
        if (Array.isArray(s.solid) && s.solid.length === AZ_STEPS) spot.solid.set(s.solid);
        if (Array.isArray(s.leafy) && s.leafy.length === AZ_STEPS) spot.leafy.set(s.leafy);
        return spot;
      });
      state.active = Math.min(saved.active ?? 0, state.spots.length - 1);
    } else if (Array.isArray(saved.skyline) && saved.skyline.length === AZ_STEPS) {
      // migrate the single-skyline format of the first prototype
      state.spots[0].solid.set(saved.skyline);
    }
  } catch { /* ignore corrupt storage */ }
}

function persist() {
  localStorage.setItem(
    'sun-garden',
    JSON.stringify({
      lat: state.lat,
      lon: state.lon,
      active: state.active,
      spots: state.spots.map((s) => ({
        name: s.name,
        solid: Array.from(s.solid),
        leafy: Array.from(s.leafy),
      })),
    }),
  );
}

// ---------------------------------------------------------------- skyline

function layerAt(arr, az) {
  const a = ((az % 360) + 360) % 360;
  const i = Math.floor(a);
  const f = a - i;
  return arr[i] * (1 - f) + arr[(i + 1) % AZ_STEPS] * f;
}

/** Leaf-on window: May–Oct in the northern hemisphere, Nov–Apr in the southern. */
function inLeaf(month) {
  return state.lat >= 0 ? month >= 5 && month <= 10 : month <= 4 || month >= 11;
}

/** Month-aware skyline for one spot: (az, month) → blocked elevation. */
function skylineFor(spot) {
  return (az, month) => {
    const solid = layerAt(spot.solid, az);
    return month === undefined || inLeaf(month)
      ? Math.max(solid, layerAt(spot.leafy, az))
      : solid;
  };
}

// ---------------------------------------------------------------- canvas

const canvas = $('pano');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;
const xOfAz = (az) => (az / 360) * W;
const yOfEl = (el) => H - (el / MAX_EL) * H;
const azOfX = (x) => (x / W) * 360;
const elOfY = (y) => ((H - y) / H) * MAX_EL;

function today() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function haloText(text, x, y) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = cssVar('--surface-1');
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

let placedLabels = [];

function drawSunPath(points, color, dashed, label, month) {
  if (points.length === 0) return;
  const skyline = skylineFor(activeSpot());
  ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [5, 5] : []);

  // Split the path into visible (above skyline) and blocked segments so shaded
  // stretches of the day read as dimmed at a glance.
  for (const blocked of [true, false]) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = blocked ? 0.25 : 1;
    ctx.beginPath();
    let pen = false;
    let prevAz = null;
    for (const p of points) {
      const isBlocked = p.elevation <= Math.max(0, skyline(p.azimuth, month));
      const wrap = prevAz !== null && Math.abs(p.azimuth - prevAz) > 180;
      prevAz = p.azimuth;
      if (isBlocked !== blocked || p.elevation < 0 || wrap) { pen = false; continue; }
      const x = xOfAz(p.azimuth);
      const y = yOfEl(p.elevation);
      if (pen) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // Label at the path's peak; if another path's label already sits there
  // (June and early-July "Today" peak in the same place), slide along the
  // path toward morning, then evening, until the label has room.
  const peak = points.reduce((a, b) => (b.elevation > a.elevation ? b : a));
  if (peak.elevation <= 0) return;
  const peakIdx = points.indexOf(peak);
  const candidates = [peakIdx, Math.floor(peakIdx * 0.55), Math.floor(peakIdx * 1.45)]
    .filter((i) => i >= 0 && i < points.length && points[i].elevation > 3);
  let pos = null;
  for (const i of candidates) {
    const x = Math.max(56, Math.min(W - 56, xOfAz(points[i].azimuth)));
    const y = Math.max(14, yOfEl(points[i].elevation) - 9);
    if (!placedLabels.some((p) => Math.abs(p.x - x) < 84 && Math.abs(p.y - y) < 16)) {
      pos = { x, y };
      break;
    }
  }
  if (!pos) {
    const last = placedLabels[placedLabels.length - 1];
    pos = { x: xOfAz(peak.azimuth), y: last ? last.y + 17 : 14 };
  }
  placedLabels.push(pos);
  ctx.fillStyle = color;
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  haloText(label, pos.x, pos.y);
}

function fillLayer(arr, fill, edge, dashedEdge) {
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let a = 0; a <= AZ_STEPS; a++) {
    ctx.lineTo(xOfAz(a), yOfEl(arr[a % AZ_STEPS]));
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.setLineDash(dashedEdge ? [6, 4] : []);
  ctx.stroke();
  ctx.setLineDash([]);
}

function draw() {
  placedLabels = [];
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--surface-1');
  ctx.fillRect(0, 0, W, H);

  if (state.photo) {
    ctx.globalAlpha = 0.9;
    ctx.drawImage(state.photo, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // grid: elevation every 15°, azimuth every 45°
  ctx.strokeStyle = cssVar('--gridline');
  ctx.lineWidth = 1;
  for (let el = 15; el < MAX_EL; el += 15) {
    ctx.beginPath(); ctx.moveTo(0, yOfEl(el)); ctx.lineTo(W, yOfEl(el)); ctx.stroke();
  }
  for (let az = 45; az < 360; az += 45) {
    ctx.beginPath(); ctx.moveTo(xOfAz(az), 0); ctx.lineTo(xOfAz(az), H); ctx.stroke();
  }

  // skyline layers: deciduous first, solid over it
  const spot = activeSpot();
  fillLayer(spot.leafy, cssVar('--leafy-fill'), cssVar('--leafy-edge'), true);
  fillLayer(spot.solid, cssVar('--skyline-fill'), cssVar('--skyline-edge'), false);

  // sun paths: solstices + equinox + today
  const { y, m, d } = today();
  drawSunPath(sunPathForDay(state.lat, state.lon, y, 6, 21), cssVar('--path-june'), false, 'Jun 21', 6);
  drawSunPath(sunPathForDay(state.lat, state.lon, y, 3, 21), cssVar('--path-equinox'), false, 'Mar / Sep 21', 3);
  drawSunPath(sunPathForDay(state.lat, state.lon, y, 12, 21), cssVar('--path-december'), false, 'Dec 21', 12);
  if (!(m === 6 || m === 3 || m === 12) || d !== 21) {
    drawSunPath(sunPathForDay(state.lat, state.lon, y, m, d), cssVar('--path-today'), true, 'Today', m);
  }

  // the sun right now, if up
  const now = solarPosition(state.lat, state.lon, Date.now());
  if (now.elevation > 0) {
    ctx.beginPath();
    ctx.arc(xOfAz(now.azimuth), yOfEl(now.elevation), 7, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--path-today');
    ctx.fill();
    ctx.strokeStyle = cssVar('--surface-1');
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // compass + elevation labels
  ctx.fillStyle = cssVar('--text-muted');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const [az, name] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    haloText(name, Math.max(8, xOfAz(az)), H - 6);
  }
  ctx.textAlign = 'left';
  for (let el = 15; el < MAX_EL; el += 30) {
    haloText(`${el}°`, 4, yOfEl(el) - 3);
  }
}

// -------- skyline drawing (pointer events)

let drawing = false;
let lastAz = null;

function paintSkyline(az, el) {
  const arr = activeSpot()[state.brush];
  const a = Math.round(((az % 360) + 360) % 360) % AZ_STEPS;
  const v = Math.max(0, Math.min(85, el));
  if (lastAz !== null && Math.abs(a - lastAz) <= 180) {
    // fill the bins the pointer skipped over during a fast drag
    const from = Math.min(lastAz, a);
    const to = Math.max(lastAz, a);
    for (let i = from; i <= to; i++) arr[i] = v;
  } else {
    arr[a] = v;
  }
  lastAz = a;
}

function pointerPos(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    az: azOfX(((ev.clientX - r.left) / r.width) * W),
    el: elOfY(((ev.clientY - r.top) / r.height) * H),
  };
}

canvas.addEventListener('pointerdown', (ev) => {
  drawing = true;
  lastAz = null;
  canvas.setPointerCapture(ev.pointerId);
  const { az, el } = pointerPos(ev);
  paintSkyline(az, el);
  draw();
});

canvas.addEventListener('pointermove', (ev) => {
  const { az, el } = pointerPos(ev);
  const blocked = el <= Math.max(0, skylineFor(activeSpot())(az, today().m));
  $('readout').textContent =
    `Azimuth ${az.toFixed(0)}° · elevation ${el.toFixed(0)}° — ` +
    (blocked ? 'blocked by skyline here (this month)' : 'open sky here');
  if (!drawing) return;
  paintSkyline(az, el);
  draw();
});

function endStroke() {
  if (!drawing) return;
  drawing = false;
  lastAz = null;
  persist();
  scheduleRecompute();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('pointerleave', () => { $('readout').innerHTML = '&nbsp;'; });

// ---------------------------------------------------------------- report

const CAT_VARS = {
  'Full sun': '--cat-full-sun',
  'Part sun': '--cat-part-sun',
  'Part shade': '--cat-part-shade',
  'Full shade': '--cat-full-shade',
};
const catColor = (name) => cssVar(CAT_VARS[name]);

const tooltip = $('tooltip');

function renderLegend() {
  $('legend').innerHTML = Object.entries(CAT_VARS)
    .map(([name, v]) => `<span><span class="swatch" style="background:var(${v})"></span>${name}</span>`)
    .join('');
}

function renderChart(report, todayMonth) {
  const vbW = 720, vbH = 280;
  const mL = 34, mR = 6, mT = 14, mB = 24;
  const plotW = vbW - mL - mR, plotH = vbH - mT - mB;
  const yMax = Math.max(12, Math.ceil(Math.max(...report.map((r) => r.hours))));
  const yOf = (h) => mT + plotH - (h / yMax) * plotH;
  const slot = plotW / 12;
  const barW = slot - 8;

  let s = `<svg viewBox="0 0 ${vbW} ${vbH}" role="img" aria-label="Direct sun hours by month">`;

  for (let h = 0; h <= yMax; h += 3) {
    s += `<line x1="${mL}" x2="${vbW - mR}" y1="${yOf(h)}" y2="${yOf(h)}" stroke="var(--gridline)" stroke-width="1"/>`;
    s += `<text x="${mL - 6}" y="${yOf(h) + 4}" text-anchor="end" fill="var(--text-muted)" style="font-variant-numeric:tabular-nums">${h}</text>`;
  }
  // full-sun threshold reference (its label is appended after the bars so
  // tall bars can't hide it)
  s += `<line x1="${mL}" x2="${vbW - mR}" y1="${yOf(6)}" y2="${yOf(6)}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="4 4"/>`;

  const maxIdx = report.reduce((bi, r, i) => (r.hours > report[bi].hours ? i : bi), 0);
  const minIdx = report.reduce((bi, r, i) => (r.hours < report[bi].hours ? i : bi), 0);

  report.forEach((r, i) => {
    const x = mL + i * slot + (slot - barW) / 2;
    const yTop = yOf(r.hours);
    const h = Math.max(0, mT + plotH - yTop);
    const rr = Math.min(4, h); // rounded data end only
    s += `<path d="M${x},${mT + plotH} v${-(h - rr)} q0,${-rr} ${rr},${-rr} h${barW - 2 * rr} q${rr},0 ${rr},${rr} v${h - rr} z"
      fill="${catColor(r.category.name)}" data-i="${i}"/>`;
    if (i === maxIdx || i === minIdx) {
      s += `<text x="${x + barW / 2}" y="${yTop - 6}" text-anchor="middle" fill="var(--text-secondary)" style="font-variant-numeric:tabular-nums">${r.hours.toFixed(1)}</text>`;
    }
    const isToday = i + 1 === todayMonth;
    s += `<text x="${x + barW / 2}" y="${vbH - 8}" text-anchor="middle" fill="var(--text-${isToday ? 'primary' : 'muted'})" ${isToday ? 'font-weight="600"' : ''}>${MONTHS[i]}</text>`;
    // full-height invisible hover target
    s += `<rect x="${mL + i * slot}" y="${mT}" width="${slot}" height="${plotH}" fill="transparent" data-hit="${i}"/>`;
  });

  s += `<text x="${vbW - mR}" y="${yOf(6) - 5}" text-anchor="end" fill="var(--text-muted)" stroke="var(--surface-1)" stroke-width="3" paint-order="stroke">full-sun threshold</text>`;
  s += `<line x1="${mL}" x2="${vbW - mR}" y1="${mT + plotH}" y2="${mT + plotH}" stroke="var(--baseline)" stroke-width="1"/>`;
  s += '</svg>';
  $('chart').innerHTML = s;

  $('chart').querySelectorAll('[data-hit]').forEach((el) => {
    const r = report[Number(el.dataset.hit)];
    el.addEventListener('pointermove', (ev) => {
      tooltip.style.display = 'block';
      tooltip.innerHTML = `<strong>${MONTHS[r.month - 1]} 21</strong> · ${r.hours.toFixed(1)} h direct sun<br><span class="cat">${r.category.name}</span>`;
      tooltip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8)}px`;
      tooltip.style.top = `${ev.clientY + 14}px`;
    });
    el.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });
  });
}

function renderTable(report) {
  $('dataTable').querySelector('tbody').innerHTML = report
    .map((r) => `<tr><td>${MONTHS[r.month - 1]}</td><td class="num">${r.hours.toFixed(1)} h</td><td>${r.category.name}</td></tr>`)
    .join('');
}

// -------- daily sun timeline ("when exactly is this spot shaded?")

const fmtSolar = (minFromNoon) => {
  const t = 720 + minFromNoon;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.round(t % 60)).padStart(2, '0')}`;
};

function renderTimeline() {
  const { y } = today();
  const month = state.timelineMonth;
  const skyline = skylineFor(activeSpot());
  const vbW = 720, vbH = 64;
  const mL = 8, mR = 8, top = 8, barH = 26;
  const winStart = -480, winEnd = 600; // 04:00 → 22:00 solar time
  const xOf = (min) => mL + ((min - winStart) / (winEnd - winStart)) * (vbW - mL - mR);
  const step = 5;

  // Build per-step status: 0 night, 1 blocked, 2 lit.
  const statuses = [];
  const noonMs = Date.UTC(y, month - 1, 21, 12) - (state.lon / 15) * 3600000;
  for (let m = winStart; m <= winEnd; m += step) {
    const { azimuth, elevation } = solarPosition(state.lat, state.lon, noonMs + m * 60000);
    statuses.push({
      m,
      s: elevation <= 0 ? 0 : elevation > Math.max(0, skyline(azimuth, month)) ? 2 : 1,
    });
  }

  const colors = ['var(--gridline)', 'var(--skyline-edge)', 'var(--path-june)'];
  let s = `<svg viewBox="0 0 ${vbW} ${vbH}" role="img" aria-label="Direct sun through the day on ${MONTHS[month - 1]} 21">`;
  for (let i = 0; i < statuses.length - 1; i++) {
    s += `<rect x="${xOf(statuses[i].m)}" y="${top}" width="${xOf(statuses[i + 1].m) - xOf(statuses[i].m) + 0.5}" height="${barH}" fill="${colors[statuses[i].s]}"/>`;
  }
  for (let hh = 6; hh <= 21; hh += 3) {
    const x = xOf((hh - 12) * 60);
    s += `<line x1="${x}" x2="${x}" y1="${top}" y2="${top + barH + 4}" stroke="var(--baseline)" stroke-width="1"/>`;
    s += `<text x="${x}" y="${vbH - 8}" text-anchor="middle" fill="var(--text-muted)">${String(hh).padStart(2, '0')}:00</text>`;
  }
  s += '</svg>';
  $('timeline').innerHTML = s;

  const intervals = sunIntervalsForDay(state.lat, state.lon, y, month, 21, skyline);
  const total = intervals.reduce((sum, iv) => sum + (iv.endMin - iv.startMin), 0) / 60;
  $('tlSummary').textContent = intervals.length
    ? `Direct sun ${intervals.map((iv) => `${fmtSolar(iv.startMin)}–${fmtSolar(iv.endMin)}`).join(', ')} · ${total.toFixed(1)} h total (local solar time; noon = sun highest)`
    : 'No direct sun at this spot on this day.';
}

// -------- spot comparison

function renderComparison() {
  const { y, m, d } = today();
  $('compareCard').style.display = state.spots.length > 1 ? '' : 'none';
  if (state.spots.length < 2) return;
  $('compareTable').querySelector('tbody').innerHTML = state.spots
    .map((spot, i) => {
      const sk = skylineFor(spot);
      const now = sunHoursForDay(state.lat, state.lon, y, m, d, sk);
      const jun = sunHoursForDay(state.lat, state.lon, y, 6, 21, sk);
      const dec = sunHoursForDay(state.lat, state.lon, y, 12, 21, sk);
      const cat = categorize(now);
      const active = i === state.active ? ' style="font-weight:600"' : '';
      return `<tr${active}><td>${spot.name}</td><td class="num">${now.toFixed(1)} h</td><td class="num">${jun.toFixed(1)} h</td><td class="num">${dec.toFixed(1)} h</td>
        <td><span class="swatch" style="background:${catColor(cat.name)}"></span> ${cat.name}</td></tr>`;
    })
    .join('');
}

function recompute() {
  const { y, m, d } = today();
  const skyline = skylineFor(activeSpot());
  const report = monthlyReport(state.lat, state.lon, y, skyline);
  const todayHours = sunHoursForDay(state.lat, state.lon, y, m, d, skyline);
  const cat = categorize(todayHours);

  $('heroHours').textContent = `${todayHours.toFixed(1)} h`;
  $('heroSub').textContent = `direct sun today at “${activeSpot().name}”`;
  $('heroChip').innerHTML =
    `<span class="swatch" style="background:${catColor(cat.name)}"></span>${cat.name}`;
  renderChart(report, m);
  renderTable(report);
  renderTimeline();
  renderComparison();
}

let recomputeTimer = null;
function scheduleRecompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 150);
}

// ---------------------------------------------------------------- controls

function renderSpotSelect() {
  $('spotSel').innerHTML = state.spots
    .map((s, i) => `<option value="${i}" ${i === state.active ? 'selected' : ''}>${s.name.replace(/</g, '&lt;')}</option>`)
    .join('');
}

$('spotSel').addEventListener('change', (ev) => {
  state.active = Number(ev.target.value);
  persist();
  draw();
  scheduleRecompute();
});

$('addSpot').addEventListener('click', () => {
  const name = (prompt('Name this spot (e.g. "Fence bed", "Porch"):', `Spot ${state.spots.length + 1}`) || '').trim();
  if (!name) return;
  state.spots.push(makeSpot(name));
  state.active = state.spots.length - 1;
  renderSpotSelect();
  persist();
  draw();
  scheduleRecompute();
});

$('renameSpot').addEventListener('click', () => {
  const name = (prompt('New name for this spot:', activeSpot().name) || '').trim();
  if (!name) return;
  activeSpot().name = name;
  renderSpotSelect();
  persist();
  recompute();
});

$('delSpot').addEventListener('click', () => {
  if (state.spots.length === 1) {
    alert('At least one spot is needed — use “Reset skyline” to clear it instead.');
    return;
  }
  if (!confirm(`Delete “${activeSpot().name}” and its skyline?`)) return;
  state.spots.splice(state.active, 1);
  state.active = Math.max(0, state.active - 1);
  renderSpotSelect();
  persist();
  draw();
  scheduleRecompute();
});

document.querySelectorAll('input[name="brush"]').forEach((el) => {
  el.addEventListener('change', () => { state.brush = el.value; });
});

$('obType').addEventListener('change', (ev) => {
  $('obWidthField').style.display = ev.target.value === 'tree' ? '' : 'none';
});

$('obApply').addEventListener('click', () => {
  const params = {
    azimuth: Number($('obAz').value),
    distance: Number($('obDist').value),
    height: Number($('obHeight').value),
    crownWidth: Number($('obWidth').value),
    plantHeight: Number($('obPlantH').value),
  };
  if (!(params.distance > 0) || !(params.height > 0)) {
    alert('Distance and height must be positive numbers.');
    return;
  }
  if (params.height <= params.plantHeight) {
    alert('The obstacle is no taller than your plant — it casts no shadow on it.');
    return;
  }
  const profile = $('obType').value === 'tree' ? treeProfile(params) : fenceProfile(params);
  paintProfile(activeSpot()[state.brush], profile);
  persist();
  draw();
  scheduleRecompute();
});

$('tlMonth').addEventListener('change', (ev) => {
  state.timelineMonth = Number(ev.target.value);
  renderTimeline();
});

function setLocation(lat, lon) {
  state.lat = Math.max(-89.9, Math.min(89.9, lat));
  state.lon = Math.max(-180, Math.min(180, lon));
  $('lat').value = state.lat;
  $('lon').value = state.lon;
  persist();
  draw();
  scheduleRecompute();
}

$('lat').addEventListener('change', () => setLocation(Number($('lat').value), state.lon));
$('lon').addEventListener('change', () => setLocation(state.lat, Number($('lon').value)));

$('preset').addEventListener('change', (ev) => {
  if (!ev.target.value) return;
  const [lat, lon] = ev.target.value.split(',').map(Number);
  setLocation(lat, lon);
});

$('geo').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Geolocation is not available in this browser.');
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude),
    (err) => alert(`Could not get location: ${err.message}`),
    { timeout: 10000 },
  );
});

$('photoBtn').addEventListener('click', () => $('photo').click());
$('photo').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => { state.photo = img; draw(); };
  img.src = URL.createObjectURL(file);
});

$('reset').addEventListener('click', () => {
  activeSpot().solid.fill(0);
  activeSpot().leafy.fill(0);
  persist();
  draw();
  scheduleRecompute();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  draw();
  recompute();
});

// ---------------------------------------------------------------- boot

loadSaved();
$('lat').value = state.lat;
$('lon').value = state.lon;
$('tlMonth').innerHTML = MONTHS
  .map((n, i) => `<option value="${i + 1}" ${i + 1 === state.timelineMonth ? 'selected' : ''}>${n} 21</option>`)
  .join('');
renderSpotSelect();
renderLegend();
draw();
recompute();
