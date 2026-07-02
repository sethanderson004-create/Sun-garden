/**
 * AR sun view: live camera + device orientation, with the year's sun paths
 * projected onto the sky and a "spot check" that counts direct-sun hours by
 * classifying sky vs. obstruction along each arc while the user sweeps.
 *
 * Everything runs on-device. The engine modules stay sensor/DOM free; all
 * camera, orientation, and pixel work lives here.
 *
 * Frames and conventions:
 * - World frame: x = east, y = north, z = up. Azimuth is degrees clockwise
 *   from true north, elevation degrees above the horizon (same as engine).
 * - Device frame (W3C DeviceOrientation): x = right of screen, y = top of
 *   screen, z = out of the screen. The back camera looks along -z.
 * - R = Rz(alpha)·Rx(beta)·Ry(gamma) maps device vectors into the world
 *   frame; we project world points with d = Rᵀ·v and a pinhole model.
 */

import { solarPosition, solarNoonUtcMs } from './solar.js?v=5';
import { sunPathForDay, categorize } from './sunhours.js?v=5';

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const D2R = Math.PI / 180;

// Vertical field of view (portrait) of the displayed, cover-cropped camera
// feed. Phone main cameras land in the 55–70° range; the browser exposes no
// exact value, and "Align to sun" absorbs the error that matters (azimuth).
const V_FOV = 64;

const CAT_VARS = {
  'Full sun': '--cat-full-sun',
  'Part sun': '--cat-part-sun',
  'Part shade': '--cat-part-shade',
  'Full shade': '--cat-full-shade',
};

// The "measured sun → plant decision" bridge, in seed-packet language.
const ADVICE = {
  'Full sun': 'tomatoes, peppers, squash, basil',
  'Part sun': 'bush beans, beets, carrots, chard',
  'Part shade': 'lettuce, spinach, kale, cilantro',
  'Full shade': 'ferns and hostas — pick a brighter spot for vegetables',
};

// ---------------------------------------------------------------- state

const state = {
  lat: 47.6062,
  lon: -122.3321,
  azOffset: 0, // degrees added by "Align to sun" (compass + declination fix)
  sweeping: false,
  manualLook: false, // no usable orientation sensor: drag to look
  manual: { az: 180, el: 20 },
};

// Reuse the tracer's saved location (same origin, same localStorage key).
try {
  const saved = JSON.parse(localStorage.getItem('sun-garden') || 'null');
  if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) {
    state.lat = saved.lat;
    state.lon = saved.lon;
  }
} catch { /* ignore corrupt storage */ }

function persistLocation() {
  try {
    const saved = JSON.parse(localStorage.getItem('sun-garden') || 'null') || {};
    saved.lat = state.lat;
    saved.lon = state.lon;
    localStorage.setItem('sun-garden', JSON.stringify(saved));
  } catch { /* storage full/blocked: location just won't stick */ }
}

// ---------------------------------------------------------------- sun paths

/**
 * The arcs to draw and measure. Each carries the engine's 5-minute path
 * samples plus per-sample sweep bookkeeping (0 unknown, 1 blocked, 2 lit).
 */
let days = [];

function buildDays() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const defs = [
    { label: 'Jun 21', month: 6, day: 21, colorVar: '--path-june' },
    { label: 'Mar / Sep 21', month: 3, day: 21, colorVar: '--path-equinox' },
    { label: 'Dec 21', month: 12, day: 21, colorVar: '--path-december' },
  ];
  if (!((m === 6 || m === 3 || m === 12) && d === 21)) {
    defs.unshift({ label: 'Today', month: m, day: d, colorVar: '--path-today', dashed: true, today: true });
  } else {
    defs.find((def) => def.month === m).today = true;
  }
  days = defs.map((def) => {
    const points = sunPathForDay(state.lat, state.lon, y, def.month, def.day);
    const noon = solarNoonUtcMs(y, def.month, def.day, state.lon);
    return {
      ...def,
      points,
      solarMin: points.map((p) => Math.round((p.utcMs - noon) / 60000)), // min from solar noon
      status: new Uint8Array(points.length),
      bestDist: new Float32Array(points.length).fill(Infinity),
    };
  });
  renderChips();
}

// ---------------------------------------------------------------- orientation
//
// Complementary filter. The relative deviceorientation stream (gyro-fused by
// the OS: smooth, but with an arbitrary yaw zero that drifts) drives
// frame-to-frame motion. Raw compass headings jump around by ±10° while the
// phone pans, so steering the view with them directly makes the arcs swim —
// instead the compass only *slowly* pulls the yaw reference, and "Align to
// sun" pins it exactly.

let R = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // row-major device→world
let sensorSeen = false;
let curAlpha = 0; // alpha of the attitude stream (for compass anchoring)
let headingOffset = null; // yaw anchor: world alpha ≈ curAlpha + headingOffset
let anchorFrozen = false; // set by "Align to sun": gyro + sun outrank the compass
let rateDps = 0; // smoothed angular speed, gates the compass
let lastEv = null; // previous attitude event, for the rate estimate
let lastRelMs = -Infinity;

const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180; // shortest a−b
const angleLerp = (a, b, t) => a + angleDiff(b, a) * t;

/**
 * Build R for one event directly — never smooth alpha/beta/gamma separately:
 * with the phone upright (beta ≈ 90°, exactly this app's pose) the Euler
 * decomposition is near gimbal lock, alpha and gamma can jump together while
 * describing the same attitude, and per-angle blending turns that into wild
 * view swings. The matrix per event is unique and the gyro stream is smooth.
 */
function handleAttitude(ev) {
  const alpha = ev.alpha ?? 0, beta = ev.beta, gamma = ev.gamma ?? 0;
  const ms = performance.now();
  if (lastEv) {
    const dt = Math.max(0.004, (ms - lastEv.ms) / 1000);
    const moved =
      Math.abs(angleDiff(alpha, lastEv.alpha)) +
      Math.abs(beta - lastEv.beta) +
      Math.abs(angleDiff(gamma, lastEv.gamma));
    rateDps = 0.8 * rateDps + 0.2 * (moved / dt);
  }
  lastEv = { ms, alpha, beta, gamma };
  curAlpha = alpha;
  const a = (alpha + (headingOffset ?? 0)) * D2R;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(beta * D2R), sB = Math.sin(beta * D2R);
  const cG = Math.cos(gamma * D2R), sG = Math.sin(gamma * D2R);
  R = [
    cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
    sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
    -cB * sG, sB, cB * cG,
  ];
  sensorSeen = true;
  state.manualLook = false;
}

/**
 * The compass wanders by tens of degrees while the phone moves, and its
 * heading is weakly defined with the phone held upright — low-pass filtering
 * alone just follows that wander. So the compass sets the initial reference,
 * then may only steer *slowly while the device is still*, and not at all
 * once "Align to sun" has pinned the heading.
 */
function anchorHeading(absAlpha) {
  if (!sensorSeen) return;
  const target = absAlpha - curAlpha;
  if (headingOffset === null) {
    headingOffset = angleDiff(target, 0);
    return;
  }
  if (anchorFrozen || rateDps > 15) return;
  headingOffset = angleLerp(headingOffset, target, 0.01);
}

/** Relative attitude stream (gyro-fused, fires ~60 Hz on phones). */
function onRelOrientation(ev) {
  if (ev.beta === null || ev.beta === undefined) return;
  lastRelMs = performance.now();
  handleAttitude(ev);
  // iOS: the (magnetic-north) compass rides along on the relative event
  if (ev.webkitCompassHeading !== undefined) anchorHeading(360 - ev.webkitCompassHeading);
}

/** Absolute orientation (Android): compass anchor — and attitude fallback. */
function onAbsOrientation(ev) {
  if (ev.beta === null || ev.beta === undefined) return;
  // when this is also the attitude source, curAlpha is absolute and the
  // anchor target settles to ~0
  if (performance.now() - lastRelMs > 1000) handleAttitude(ev);
  anchorHeading(ev.alpha ?? 0);
}

// ---------------------------------------------------------------- projection

const canvas = $('ov');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const worldVec = (az, el) => [
  Math.sin(az * D2R) * Math.cos(el * D2R),
  Math.cos(az * D2R) * Math.cos(el * D2R),
  Math.sin(el * D2R),
];

/** World direction (az, el) → screen point {x, y}, or null if behind the camera. */
function project(az, el) {
  // the align offset corrects the compass; manual look has no compass
  const v = worldVec(state.manualLook ? az : az + state.azOffset, el);
  let dx, dy, dz;
  if (state.manualLook) {
    // Synthetic upright camera facing manual.az / manual.el.
    const f = worldVec(state.manual.az, state.manual.el);
    const rt = [Math.cos(state.manual.az * D2R), -Math.sin(state.manual.az * D2R), 0];
    const up = [rt[1] * f[2] - rt[2] * f[1], rt[2] * f[0] - rt[0] * f[2], rt[0] * f[1] - rt[1] * f[0]];
    dx = v[0] * rt[0] + v[1] * rt[1] + v[2] * rt[2];
    dy = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
    dz = -(v[0] * f[0] + v[1] * f[1] + v[2] * f[2]);
  } else {
    dx = R[0] * v[0] + R[3] * v[1] + R[6] * v[2];
    dy = R[1] * v[0] + R[4] * v[1] + R[7] * v[2];
    dz = R[2] * v[0] + R[5] * v[1] + R[8] * v[2];
    // compensate viewport rotation (landscape); portrait angle is 0
    const sa = (screen.orientation?.angle ?? 0) * D2R;
    if (sa) {
      const rx = dx * Math.cos(sa) + dy * Math.sin(sa);
      dy = -dx * Math.sin(sa) + dy * Math.cos(sa);
      dx = rx;
    }
  }
  if (dz > -0.08) return null;
  const f = (H / 2) / Math.tan((V_FOV / 2) * D2R);
  return { x: W / 2 + (f * dx) / -dz, y: H / 2 - (f * dy) / -dz };
}

/** Azimuth/elevation of the screen center (where the crosshair points). */
function centerDirection() {
  if (state.manualLook) return { az: state.manual.az, el: state.manual.el };
  // camera look direction in world coords: R · (0,0,-1) = -3rd column of R
  const lx = -R[2], ly = -R[5], lz = -R[8];
  return {
    az: ((Math.atan2(lx, ly) / D2R) + 360) % 360,
    el: Math.asin(Math.max(-1, Math.min(1, lz))) / D2R,
  };
}

// ---------------------------------------------------------------- drawing

function haloText(text, x, y, color) {
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(10,12,16,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawArc(day) {
  const color = cssVar(day.colorVar);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.setLineDash(day.dashed ? [6, 6] : []);
  ctx.beginPath();
  let pen = false;
  let prev = null;
  let peak = null;
  const proj = new Array(day.points.length).fill(null);
  for (let i = 0; i < day.points.length; i++) {
    const pt = day.points[i];
    if (pt.elevation < 0) { pen = false; continue; }
    const p = project(pt.azimuth, pt.elevation);
    proj[i] = p;
    if (!p || (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > W / 2)) { pen = false; prev = p; continue; }
    if (pen) ctx.lineTo(p.x, p.y);
    else { ctx.moveTo(p.x, p.y); pen = true; }
    prev = p;
    const onScreen = p.x > -20 && p.x < W + 20 && p.y > -20 && p.y < H + 20;
    if (onScreen && (!peak || pt.elevation > peak.el)) peak = { el: pt.elevation, x: p.x, y: p.y };
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // solar-time ticks each hour, labels every 3 h
  for (let i = 0; i < day.points.length; i++) {
    const p = proj[i];
    if (!p || day.solarMin[i] % 60 !== 0) continue;
    if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
    const hour = 12 + day.solarMin[i] / 60;
    ctx.beginPath();
    ctx.arc(p.x, p.y, day.solarMin[i] % 180 === 0 ? 3.5 : 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // label below the dot: the space above the peak belongs to the day label
    if (day.solarMin[i] % 180 === 0 && !day.dashed) haloText(String(hour), p.x, p.y + 16, color);
  }

  // sweep feedback: paint classified samples over the arc
  if (state.sweeping || day.decided > 0) {
    for (let i = 0; i < day.points.length; i++) {
      const p = proj[i];
      if (!p || day.status[i] === 0) continue;
      if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = day.status[i] === 2 ? 'rgba(255,214,90,0.9)' : 'rgba(30,34,42,0.85)';
      ctx.fill();
    }
  }

  if (peak) haloText(day.label, Math.max(48, Math.min(W - 48, peak.x)), Math.max(18, peak.y - 14), color);
}

function drawSunNow() {
  const now = solarPosition(state.lat, state.lon, Date.now());
  if (now.elevation < -2) return;
  const p = project(now.azimuth, now.elevation);
  if (!p) return;
  const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 26);
  g.addColorStop(0, 'rgba(255,220,110,0.95)');
  g.addColorStop(1, 'rgba(255,220,110,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd34d';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(10,12,16,0.7)';
  ctx.stroke();
}

function drawHorizonAndCrosshair() {
  // dashed true-horizon line (elevation 0) — anchors the scene
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  let pen = false;
  let prev = null;
  const { az: centerAz } = centerDirection();
  for (let a = -110; a <= 110; a += 2) {
    const p = project(centerAz + a, 0);
    if (!p || (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > W / 2)) { pen = false; prev = p; continue; }
    if (pen) ctx.lineTo(p.x, p.y);
    else { ctx.moveTo(p.x, p.y); pen = true; }
    prev = p;
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // compass letters on the horizon
  const dirs = [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']];
  for (const [az, name] of dirs) {
    const p = project(az, 0);
    if (p && p.x > 14 && p.x < W - 14 && p.y > 0 && p.y < H) haloText(name, p.x, p.y + 16, 'rgba(255,255,255,0.85)');
  }
  // crosshair
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 10, 0, Math.PI * 2);
  ctx.moveTo(W / 2 - 16, H / 2); ctx.lineTo(W / 2 - 5, H / 2);
  ctx.moveTo(W / 2 + 5, H / 2); ctx.lineTo(W / 2 + 16, H / 2);
  ctx.moveTo(W / 2, H / 2 - 16); ctx.lineTo(W / 2, H / 2 - 5);
  ctx.moveTo(W / 2, H / 2 + 5); ctx.lineTo(W / 2, H / 2 + 16);
  ctx.stroke();
}

const COMPASS_NAMES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

let running = false;
function frame() {
  if (!running) return;
  ctx.clearRect(0, 0, W, H);
  drawHorizonAndCrosshair();
  for (let i = days.length - 1; i >= 0; i--) drawArc(days[i]);
  drawSunNow();
  if (state.sweeping) sampleSweep();

  const { az, el } = centerDirection();
  $('headingReadout').textContent =
    `${COMPASS_NAMES[Math.round(az / 22.5) % 16]} ${Math.round(az)}° · ${el >= 0 ? '↑' : '↓'}${Math.abs(Math.round(el))}°${state.manualLook ? ' · drag' : ''}`;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- spot check

const video = $('cam');
const sampleCanvas = document.createElement('canvas');
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
let lastSampleMs = 0;

/** Sky vs obstruction, tuned for "is direct sun possible through here". */
function isSky(r, g, b) {
  return (b > 120 && b > r * 1.05 && b >= g * 0.98) || (r > 185 && g > 190 && b > 185);
}

function sampleSweep() {
  const nowMs = performance.now();
  if (nowMs - lastSampleMs < 120) return;
  lastSampleMs = nowMs;
  if (!video.videoWidth) return;

  const sw = 320;
  const sh = Math.round((video.videoHeight / video.videoWidth) * sw);
  if (sampleCanvas.width !== sw || sampleCanvas.height !== sh) {
    sampleCanvas.width = sw;
    sampleCanvas.height = sh;
  }
  sampleCtx.drawImage(video, 0, 0, sw, sh);
  let data;
  try {
    data = sampleCtx.getImageData(0, 0, sw, sh).data;
  } catch { return; }

  // screen → video pixel mapping for object-fit: cover
  const scale = Math.max(W / video.videoWidth, H / video.videoHeight);
  const ox = (W - video.videoWidth * scale) / 2;
  const oy = (H - video.videoHeight * scale) / 2;
  const toSample = (x, y) => ({
    sx: Math.round(((x - ox) / scale) * (sw / video.videoWidth)),
    sy: Math.round(((y - oy) / scale) * (sh / video.videoHeight)),
  });

  for (const day of days) {
    for (let i = 0; i < day.points.length; i++) {
      const pt = day.points[i];
      if (pt.elevation <= 0) continue;
      const p = project(pt.azimuth, pt.elevation);
      if (!p) continue;
      // trust only samples near the screen center, where the FOV model is best
      const dist = Math.max(Math.abs(p.x - W / 2) / W, Math.abs(p.y - H / 2) / H);
      if (dist > 0.36 || dist >= day.bestDist[i]) continue;
      const { sx, sy } = toSample(p.x, p.y);
      if (sx < 1 || sy < 1 || sx >= sw - 1 || sy >= sh - 1) continue;
      let r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((sy + dy) * sw + sx + dx) * 4;
          r += data[o]; g += data[o + 1]; b += data[o + 2];
        }
      }
      day.bestDist[i] = dist;
      day.status[i] = isSky(r / 9, g / 9, b / 9) ? 2 : 1;
    }
  }
  renderChips();
}

function sweepResults(day) {
  let lit = 0, decided = 0, above = 0;
  for (let i = 0; i < day.points.length; i++) {
    if (day.points[i].elevation <= 0) continue;
    above++;
    if (day.status[i] !== 0) decided++;
    if (day.status[i] === 2) lit++;
  }
  day.decided = decided;
  return { hours: (lit * 5) / 60, coverage: above ? decided / above : 0 };
}

function renderChips() {
  $('chips').innerHTML = days
    .map((day, i) => {
      const { hours, coverage } = sweepResults(day);
      const detail = coverage > 0
        ? ` <b>${hours.toFixed(1)} h</b> <small>${coverage >= 0.9 ? categorize(hours).name : `${Math.round(coverage * 100)}% swept`}</small>`
        : '';
      return `<span class="chip"><span class="dot" style="background:var(${day.colorVar})"></span>${day.label}${detail}</span>`;
    })
    .join('');

  const today = days.find((d) => d.today);
  const res = today && sweepResults(today);
  $('saveBtn').disabled = !(res && res.coverage >= 0.5);
  if (res && res.coverage >= 0.85) {
    const cat = categorize(res.hours);
    $('advice').style.display = '';
    $('advice').innerHTML =
      `<strong style="color:var(${CAT_VARS[cat.name]})">${cat.name}</strong> — about ${res.hours.toFixed(1)} h direct sun here today.<br>` +
      `Happy here: ${ADVICE[cat.name]}.<br><small style="color:rgba(255,255,255,.6)">Leafy trees are counted as they look right now — the ` +
      `<a href="./index.html" style="color:inherit">skyline tracer</a> can model them bare in winter.</small>`;
  }
}

// ---------------------------------------------------------------- controls

const toastEl = $('toast');
let toastTimer = null;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, ms);
}

$('alignBtn').addEventListener('click', () => {
  if (state.manualLook) {
    toast('Drag mode has no compass to correct — alignment is only needed on a phone.');
    return;
  }
  const sun = solarPosition(state.lat, state.lon, Date.now());
  if (sun.elevation < 0) {
    toast('The sun is below the horizon right now — try aligning in daylight.');
    return;
  }
  // A feature at azimuth A renders where the (imperfect) compass model puts
  // A + azOffset. The user is aiming the crosshair at the sun, so solve for
  // the offset that makes the sun's true azimuth land on the crosshair.
  const { az } = centerDirection(); // compass-model azimuth of the crosshair
  state.azOffset = ((az - sun.azimuth + 540) % 360) - 180;
  anchorFrozen = true; // from here on: gyro + this sun fix; the compass is done
  toast('Aligned to the sun ✓ — heading locked. If arcs drift after a while, tap again.');
});

$('sweepBtn').addEventListener('click', () => {
  state.sweeping = !state.sweeping;
  if (state.sweeping) {
    for (const day of days) {
      day.status.fill(0);
      day.bestDist.fill(Infinity);
      day.decided = 0;
    }
    $('advice').style.display = 'none';
    $('sweepBtn').textContent = '⏹ Stop sweep';
    $('sweepBtn').classList.add('active');
    toast('Pan slowly left–right along the sun arcs. Dots turn gold for sun, dark for blocked.', 3600);
  } else {
    $('sweepBtn').textContent = '▶ Spot check';
    $('sweepBtn').classList.remove('active');
  }
  renderChips();
});

// -------- save a spot check (results + where you stood)

function persistCheck(entry) {
  try {
    const saved = JSON.parse(localStorage.getItem('sun-garden') || 'null') || {};
    saved.arChecks = [...(Array.isArray(saved.arChecks) ? saved.arChecks : []), entry].slice(-50);
    localStorage.setItem('sun-garden', JSON.stringify(saved));
    toast(`Saved “${entry.name}” ✓ — it's listed on the tracer page.`);
  } catch {
    toast('Could not save — browser storage is unavailable.');
  }
}

$('saveBtn').addEventListener('click', () => {
  const name = (prompt('Name this spot check (e.g. "Blueberry bed"):', 'My spot') || '').trim();
  if (!name) return;
  const entry = {
    name,
    when: new Date().toISOString(),
    lat: state.lat,
    lon: state.lon,
    days: days.map((d) => {
      const r = sweepResults(d);
      return { label: d.label, hours: +r.hours.toFixed(2), coverage: +r.coverage.toFixed(2) };
    }),
  };
  // log the precise standpoint if a quick GPS fix is available; otherwise
  // fall back to the garden's saved location
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        entry.lat = pos.coords.latitude;
        entry.lon = pos.coords.longitude;
        persistCheck(entry);
      },
      () => persistCheck(entry),
      { timeout: 4000, enableHighAccuracy: true },
    );
  } else {
    persistCheck(entry);
  }
});

// drag-to-look fallback (desktop or no sensor)
let dragging = null;
canvas.addEventListener('pointerdown', (ev) => {
  if (!state.manualLook) return;
  dragging = { x: ev.clientX, y: ev.clientY };
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!state.manualLook || !dragging) return;
  const degPerPx = V_FOV / H;
  state.manual.az = ((state.manual.az - (ev.clientX - dragging.x) * degPerPx) % 360 + 360) % 360;
  state.manual.el = Math.max(-30, Math.min(85, state.manual.el + (ev.clientY - dragging.y) * degPerPx));
  dragging = { x: ev.clientX, y: ev.clientY };
});
canvas.addEventListener('pointerup', () => { dragging = null; });

// ---------------------------------------------------------------- boot

const locLabel = () => `${state.lat.toFixed(3)}, ${state.lon.toFixed(3)}`;
$('locLabel').textContent = locLabel();

$('geoBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Geolocation is not available in this browser.');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.lat = pos.coords.latitude;
      state.lon = pos.coords.longitude;
      $('locLabel').textContent = locLabel();
      persistLocation();
      buildDays();
    },
    (err) => toast(`Could not get location: ${err.message}`),
    { timeout: 10000 },
  );
});

$('startBtn').addEventListener('click', async () => {
  // 1 — motion/compass permission (iOS needs an explicit grant from a gesture)
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch { /* declined — manual look kicks in below */ }
  // relative stream for smooth attitude; absolute stream (where it exists)
  // anchors the compass heading — see the complementary filter above
  window.addEventListener('deviceorientation', onRelOrientation);
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onAbsOrientation);
  }

  // 2 — camera (optional: without it the arcs draw over a sky gradient)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch {
    toast('No camera — showing the sun paths over a plain sky. Spot check needs the camera.');
    $('sweepBtn').disabled = true;
  }

  $('start').style.display = 'none';
  buildDays();
  running = true;
  requestAnimationFrame(frame);

  // no orientation events? fall back to dragging
  setTimeout(() => {
    if (!sensorSeen) {
      state.manualLook = true;
      toast('No compass detected — drag to look around.');
    } else {
      toast('Rough compass set. For a solid lock: point the crosshair at the sun and tap ☀ Align.', 4200);
    }
  }, 1500);
});

document.addEventListener('visibilitychange', () => {
  running = document.visibilityState === 'visible' && $('start').style.display === 'none';
  if (running) requestAnimationFrame(frame);
});

// test hook: lets an automated browser drive orientation + inspect results
window.__arDebug = { state, sweepResults: () => days.map((d) => ({ label: d.label, ...sweepResults(d) })), centerDirection };
