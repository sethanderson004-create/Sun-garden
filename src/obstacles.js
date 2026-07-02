/**
 * Measured-obstacle profiles: convert real-world measurements (height,
 * distance) into skyline elevation profiles.
 *
 * This matters most for obstructions very close to the plant, where tracing
 * a panorama is awkward and the viewing height dominates the answer: a 1.8 m
 * fence seen from a 0.6 m hedge 0.75 m away blocks up to 58°, but from a
 * camera at eye height (1.7 m) only ~8°. All lengths just need to share one
 * unit; only ratios enter the math.
 */

const RAD = Math.PI / 180;

function azDelta(az, center) {
  let d = (((az - center) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * A long straight fence/wall/hedge-line. `azimuth` is the compass direction
 * looking squarely at it, `distance` the perpendicular distance from the
 * spot, `height` its top, `plantHeight` the height the plant experiences the
 * sky from. Looking along the wall the distance grows as 1/cos, so the
 * blocked elevation tapers: el(Δ) = atan((H−h)·cosΔ / d).
 */
export function fenceProfile({ azimuth, distance, height, plantHeight = 0 }) {
  const rise = height - plantHeight;
  if (rise <= 0 || distance <= 0) return () => 0;
  return (az) => {
    const d = azDelta(az, azimuth);
    if (Math.abs(d) >= 89.5) return 0;
    return Math.atan2(rise * Math.cos(d * RAD), distance) / RAD;
  };
}

/**
 * A tree or shrub: a crown of `crownWidth` centered at `azimuth`, `distance`
 * away, reaching `height`. Modeled as an elliptical bump from the ground up
 * (conservative: ignores light through gaps under the crown).
 */
export function treeProfile({ azimuth, distance, height, crownWidth, plantHeight = 0 }) {
  const rise = height - plantHeight;
  if (rise <= 0 || distance <= 0 || crownWidth <= 0) return () => 0;
  const topEl = Math.atan2(rise, distance) / RAD;
  const halfWidth = Math.atan2(crownWidth / 2, distance) / RAD;
  return (az) => {
    const d = azDelta(az, azimuth);
    if (Math.abs(d) >= halfWidth) return 0;
    return topEl * Math.sqrt(1 - (d / halfWidth) ** 2);
  };
}

/** Merge a profile into a 1°-binned skyline array, keeping existing maxima. */
export function paintProfile(skylineArray, profile) {
  for (let a = 0; a < skylineArray.length; a++) {
    skylineArray[a] = Math.max(skylineArray[a], Math.min(85, profile(a)));
  }
}
