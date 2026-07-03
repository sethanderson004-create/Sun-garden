/**
 * Scene engine for the top-down garden map: a sketch of the yard's
 * shade-casters in world coordinates, converted into per-viewpoint skyline
 * profiles that plug straight into sunhours.js. This is what turns "draw the
 * house and the maple once" into sun hours for every point of the garden —
 * no shadow ray-casting needed, every grid cell just gets its own skyline.
 *
 * Coordinates: x grows east, y grows north, heights from the ground plane.
 * Meters recommended, but any single shared unit works — only ratios enter
 * the math. The compass azimuth from P toward Q is atan2(Qx−Px, Qy−Py),
 * consistent with the 0=N / 90=E convention used everywhere.
 *
 * A scene is `{ obstacles: [...] }` (or a bare array of obstacles):
 *   { type: 'building', footprint: [{x,y},…], height }
 *       closed polygon of vertical walls, flat top — always solid
 *   { type: 'fence', points: [{x,y},…], height }
 *       open polyline of vertical walls (fence, hedge line, wall) — solid
 *   { type: 'tree', x, y, height, crownWidth, deciduous }
 *       crown per obstacles.js treeProfile; deciduous crowns go to the leafy
 *       layer (block only in leaf), evergreen to solid
 *
 * Output matches app.js spot layers: two Float64Array(360) skylines (1°
 * azimuth bins, elevations clamped to 0–85), solid + leafy.
 */

import { treeProfile, paintProfile } from './obstacles.js?v=15'; // ?v= must match app.js — see cache-busting note there

const RAD = Math.PI / 180;
const MAX_EL = 85;
const AZ_STEPS = 360;

// Ray directions for the 360 azimuth bins, computed once: skylines are
// rebuilt per grid cell of the garden map, so per-cell trig adds up.
const DIR_X = new Float64Array(AZ_STEPS);
const DIR_Y = new Float64Array(AZ_STEPS);
for (let az = 0; az < AZ_STEPS; az++) {
  DIR_X[az] = Math.sin(az * RAD);
  DIR_Y[az] = Math.cos(az * RAD);
}

/** Compass azimuth (0=N, 90=E) of the direction (dx east, dy north). */
function azimuthTo(dx, dy) {
  return (((Math.atan2(dx, dy) / RAD) % 360) + 360) % 360;
}

/**
 * Distance from (px,py) along the unit ray (dirx,diry) to segment a→b,
 * or Infinity if the ray misses it.
 */
function rayHitDistance(px, py, dirx, diry, a, b) {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const det = ex * diry - ey * dirx;
  if (Math.abs(det) < 1e-12) return Infinity; // ray parallel to the wall
  const wx = a.x - px;
  const wy = a.y - py;
  const t = (ex * wy - ey * wx) / det; // distance along the ray
  const s = (dirx * wy - diry * wx) / det; // fraction along the segment
  return t > 1e-9 && s >= 0 && s <= 1 ? t : Infinity;
}

/** Even-odd crossing test: is (px,py) inside the polygon? */
function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (
      a.y > py !== b.y > py &&
      px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Max-merge a run of vertical walls with a common top `height` into a
 * 1°-binned skyline, by casting one ray per azimuth bin and using the
 * nearest wall hit (nearest = highest blocked elevation). `closed` adds the
 * last→first edge. Walls subtending less than the 1° ray spacing can slip
 * between rays — that matches the bin resolution used everywhere else.
 */
function paintWalls(arr, pts, closed, height, px, py, plantHeight) {
  const rise = height - plantHeight;
  if (rise <= 0 || pts.length < 2) return;
  const edges = closed ? pts.length : pts.length - 1;
  for (let az = 0; az < AZ_STEPS; az++) {
    const dirx = DIR_X[az];
    const diry = DIR_Y[az];
    let dist = Infinity;
    for (let i = 0; i < edges; i++) {
      const d = rayHitDistance(px, py, dirx, diry, pts[i], pts[(i + 1) % pts.length]);
      if (d < dist) dist = d;
    }
    if (dist < Infinity) {
      const el = Math.min(MAX_EL, Math.atan2(rise, dist) / RAD);
      if (el > arr[az]) arr[az] = el;
    }
  }
}

/**
 * The skyline a plant at (x, y, plantHeight) sees, as the same two-layer
 * shape app.js spots use: solid always blocks, leafy only in leaf.
 */
export function skylineLayersForPoint(scene, x, y, plantHeight = 0) {
  const obstacles = Array.isArray(scene) ? scene : (scene && scene.obstacles) || [];
  const solid = new Float64Array(AZ_STEPS);
  const leafy = new Float64Array(AZ_STEPS);
  for (const ob of obstacles) {
    if (ob.type === 'tree') {
      if (ob.height - plantHeight <= 0) continue;
      const layer = ob.deciduous ? leafy : solid;
      const dx = ob.x - x;
      const dy = ob.y - y;
      const distance = Math.hypot(dx, dy);
      if (distance <= (ob.crownWidth || 0) / 2) {
        layer.fill(MAX_EL); // under the canopy: conservatively full shade
      } else {
        paintProfile(
          layer,
          treeProfile({
            azimuth: azimuthTo(dx, dy),
            distance,
            height: ob.height,
            crownWidth: ob.crownWidth,
            plantHeight,
          }),
        );
      }
    } else if (ob.type === 'building') {
      if (ob.height > plantHeight && pointInPolygon(x, y, ob.footprint)) {
        solid.fill(MAX_EL); // standing inside the footprint
      } else {
        paintWalls(solid, ob.footprint, true, ob.height, x, y, plantHeight);
      }
    } else if (ob.type === 'fence') {
      paintWalls(solid, ob.points, false, ob.height, x, y, plantHeight);
    }
  }
  return { solid, leafy };
}

/**
 * Exact blocked elevation toward one azimuth — the "shadow movie" query:
 * a point is shaded at some instant iff this exceeds the sun's elevation.
 * One ray against the walls plus the tree-crown formula, no 360-bin
 * skyline build, so a whole grid can be tested per animation frame.
 * `leafOn` says whether deciduous crowns currently block.
 */
export function blockedElevationAt(scene, x, y, azimuth, leafOn = true, plantHeight = 0) {
  const obstacles = Array.isArray(scene) ? scene : (scene && scene.obstacles) || [];
  const dirx = Math.sin(azimuth * RAD);
  const diry = Math.cos(azimuth * RAD);
  let blocked = 0;
  for (const ob of obstacles) {
    if (ob.height - plantHeight <= 0) continue;
    let el = 0;
    if (ob.type === 'tree') {
      if (ob.deciduous && !leafOn) continue;
      const dx = ob.x - x;
      const dy = ob.y - y;
      const distance = Math.hypot(dx, dy);
      el = distance <= (ob.crownWidth || 0) / 2
        ? MAX_EL
        : treeProfile({
            azimuth: azimuthTo(dx, dy),
            distance,
            height: ob.height,
            crownWidth: ob.crownWidth,
            plantHeight,
          })(azimuth);
    } else if (ob.type === 'building' || ob.type === 'fence') {
      const closed = ob.type === 'building';
      const pts = closed ? ob.footprint : ob.points;
      if (closed && pointInPolygon(x, y, pts)) {
        el = MAX_EL;
      } else if (pts && pts.length >= 2) {
        const edges = closed ? pts.length : pts.length - 1;
        let dist = Infinity;
        for (let i = 0; i < edges; i++) {
          const d = rayHitDistance(x, y, dirx, diry, pts[i], pts[(i + 1) % pts.length]);
          if (d < dist) dist = d;
        }
        if (dist < Infinity) el = Math.atan2(ob.height - plantHeight, dist) / RAD;
      }
    }
    if (el > blocked) blocked = el;
  }
  return Math.min(MAX_EL, blocked);
}

/**
 * Leaf-on window: May–Oct in the northern hemisphere, Nov–Apr in the
 * southern. Engine-side twin of app.js's inLeaf (which closes over UI state).
 */
export function inLeaf(month, lat) {
  return lat >= 0 ? month >= 5 && month <= 10 : month <= 4 || month >= 11;
}

/** Linear interpolation into a 1°-binned layer, wrapping across north. */
export function layerAt(arr, az) {
  const a = ((az % 360) + 360) % 360;
  const i = Math.floor(a);
  const f = a - i;
  return arr[i] * (1 - f) + arr[(i + 1) % arr.length] * f;
}

/** Month-aware skyline function for a pair of layers: (az, month) → el. */
export function skylineAtFromLayers({ solid, leafy }, lat) {
  return (az, month) => {
    const s = layerAt(solid, az);
    return month === undefined || inLeaf(month, lat)
      ? Math.max(s, layerAt(leafy, az))
      : s;
  };
}

/**
 * One-call convenience: the month-aware skyline at a point of the scene,
 * ready for sunHoursForDay / sunIntervalsForDay / monthlyReport.
 */
export function sceneSkylineAt(scene, x, y, lat, plantHeight = 0) {
  return skylineAtFromLayers(skylineLayersForPoint(scene, x, y, plantHeight), lat);
}
