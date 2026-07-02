/**
 * Sun-Garden prototype UI: skyline tracing canvas + monthly sun-hours report.
 */

import { solarPosition } from './solar.js';
import { sunHoursForDay, sunPathForDay, monthlyReport, categorize } from './sunhours.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AZ_STEPS = 360; // skyline resolution: 1° bins
const MAX_EL = 90;

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

// ---------------------------------------------------------------- state

const state = {
  lat: 47.6062,
  lon: -122.3321,
  skyline: new Float64Array(AZ_STEPS),
  photo: null, // HTMLImageElement or null
};

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem('sun-garden') || 'null');
    if (!saved) return;
    if (Number.isFinite(saved.lat)) state.lat = saved.lat;
    if (Number.isFinite(saved.lon)) state.lon = saved.lon;
    if (Array.isArray(saved.skyline) && saved.skyline.length === AZ_STEPS) {
      state.skyline.set(saved.skyline);
    }
  } catch { /* ignore corrupt storage */ }
}

function persist() {
  localStorage.setItem(
    'sun-garden',
    JSON.stringify({ lat: state.lat, lon: state.lon, skyline: Array.from(state.skyline) }),
  );
}

function skylineAt(az) {
  const a = ((az % 360) + 360) % 360;
  const i = Math.floor(a);
  const f = a - i;
  return state.skyline[i] * (1 - f) + state.skyline[(i + 1) % AZ_STEPS] * f;
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

function drawSunPath(points, color, dashed, label) {
  if (points.length === 0) return;
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
      const isBlocked = p.elevation <= Math.max(0, skylineAt(p.azimuth));
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

  // skyline (blocked region)
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let a = 0; a <= AZ_STEPS; a++) {
    ctx.lineTo(xOfAz(a), yOfEl(state.skyline[a % AZ_STEPS]));
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = cssVar('--skyline-fill');
  ctx.fill();
  ctx.strokeStyle = cssVar('--skyline-edge');
  ctx.lineWidth = 2;
  ctx.stroke();

  // sun paths: solstices + equinox + today
  const { y, m, d } = today();
  drawSunPath(sunPathForDay(state.lat, state.lon, y, 6, 21), cssVar('--path-june'), false, 'Jun 21');
  drawSunPath(sunPathForDay(state.lat, state.lon, y, 3, 21), cssVar('--path-equinox'), false, 'Mar / Sep 21');
  drawSunPath(sunPathForDay(state.lat, state.lon, y, 12, 21), cssVar('--path-december'), false, 'Dec 21');
  if (!(m === 6 || m === 3 || m === 12) || d !== 21) {
    drawSunPath(sunPathForDay(state.lat, state.lon, y, m, d), cssVar('--path-today'), true, 'Today');
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
  const a = Math.round(((az % 360) + 360) % 360) % AZ_STEPS;
  const v = Math.max(0, Math.min(85, el));
  if (lastAz !== null && Math.abs(a - lastAz) <= 180) {
    // fill the bins the pointer skipped over during a fast drag
    const from = Math.min(lastAz, a);
    const to = Math.max(lastAz, a);
    for (let i = from; i <= to; i++) state.skyline[i] = v;
  } else {
    state.skyline[a] = v;
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
  const blocked = el <= Math.max(0, skylineAt(az));
  $('readout').textContent =
    `Azimuth ${az.toFixed(0)}° · elevation ${el.toFixed(0)}° — ` +
    (blocked ? 'blocked by skyline here' : 'open sky here');
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

function recompute() {
  const { y, m, d } = today();
  const report = monthlyReport(state.lat, state.lon, y, skylineAt);
  const todayHours = sunHoursForDay(state.lat, state.lon, y, m, d, skylineAt);
  const cat = categorize(todayHours);

  $('heroHours').textContent = `${todayHours.toFixed(1)} h`;
  $('heroChip').innerHTML =
    `<span class="swatch" style="background:${catColor(cat.name)}"></span>${cat.name}`;
  renderChart(report, m);
  renderTable(report);
}

let recomputeTimer = null;
function scheduleRecompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 150);
}

// ---------------------------------------------------------------- controls

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
  state.skyline.fill(0);
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
renderLegend();
draw();
recompute();
