/**
 * AR yard-survey math: turn crosshair sightings — the azimuth + elevation
 * the phone points at, taken from a standpoint at eye height — into
 * scene-coordinate obstacles. The clinometer principle: aiming at the point
 * where an object meets the ground gives its distance
 * (d = eyeHeight / tan(depression)), aiming at its top gives its height,
 * and two crown-edge azimuths give its width. Pure trig — sensors, GPS,
 * and DOM stay in ar.js.
 *
 * Accuracy scales with proximity (the down-angle flattens with distance),
 * so the UI tells users to walk close to what they measure; repeat
 * sightings of the same object average out (~1/√n) via mergeSighting.
 * Assumes roughly level ground between standpoint and target.
 */

const RAD = Math.PI / 180;
const M_PER_DEG = 110574; // meters per degree of latitude (lon scales by cos)

/**
 * Ground distance to a point sighted `elevationDeg` below the horizon
 * (elevation is negative looking down). Null when the sight line is at or
 * above the horizon — that never meets level ground at a usable distance.
 */
export function groundDistance(eyeHeight, elevationDeg) {
  if (!(elevationDeg < -0.75) || !(eyeHeight > 0)) return null;
  return eyeHeight / Math.tan(-elevationDeg * RAD);
}

/** Scene point of a ground sighting from `standpoint` (meters, x east / y north). */
export function sightGroundPoint(standpoint, eyeHeight, azimuthDeg, elevationDeg) {
  const distance = groundDistance(eyeHeight, elevationDeg);
  if (distance === null) return null;
  return {
    x: standpoint.x + distance * Math.sin(azimuthDeg * RAD),
    y: standpoint.y + distance * Math.cos(azimuthDeg * RAD),
    distance,
  };
}

/** Height of an object whose top is sighted at `elevationDeg`, `distance` away. */
export function sightHeight(eyeHeight, distance, elevationDeg) {
  return Math.max(0, eyeHeight + distance * Math.tan(elevationDeg * RAD));
}

/** Width spanned by two azimuth edges of something `distance` away. */
export function spanWidth(distance, azA, azB) {
  const half = Math.abs(((((azB - azA) % 360) + 540) % 360) - 180) / 2;
  return 2 * distance * Math.tan(half * RAD);
}

/** GPS fix → scene meters relative to the garden origin (lat/lon). */
export function gpsToScene(originLat, originLon, lat, lon) {
  return {
    x: (lon - originLon) * M_PER_DEG * Math.cos(originLat * RAD),
    y: (lat - originLat) * M_PER_DEG,
  };
}

/**
 * Fold a repeat measurement into a surveyed obstacle: running average of
 * position and size, weighted by how many sightings are already in it.
 */
export function mergeSighting(obstacle, measurement) {
  const n = obstacle.sightings || 1;
  const out = { ...obstacle, sightings: n + 1 };
  for (const k of ['x', 'y', 'height', 'crownWidth']) {
    if (Number.isFinite(obstacle[k]) && Number.isFinite(measurement[k])) {
      out[k] = (obstacle[k] * n + measurement[k]) / (n + 1);
    }
  }
  return out;
}
