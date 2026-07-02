/**
 * Sun-hours computation: combine the deterministic sun path with a
 * user-captured skyline profile to get direct-sun hours per day.
 *
 * A skyline profile is a function az → elevation (degrees): the angle below
 * which the sky is blocked in that compass direction. An open horizon is
 * `() => 0`.
 */

import { solarPosition, solarNoonUtcMs } from './solar.js';

export const OPEN_HORIZON = () => 0;

/** Gardening light categories, from plant-label conventions. */
export const CATEGORIES = [
  { minHours: 6, name: 'Full sun' },
  { minHours: 4, name: 'Part sun' },
  { minHours: 2, name: 'Part shade' },
  { minHours: 0, name: 'Full shade' },
];

export function categorize(hours) {
  return CATEGORIES.find((c) => hours >= c.minHours);
}

/**
 * Direct-sun hours for one calendar date at (lat, lon), given a skyline.
 * Samples a 24 h window centered on solar noon so no timezone database is
 * needed — daylight is always contiguous around solar noon.
 */
export function sunHoursForDay(lat, lon, year, month, day, skylineAt = OPEN_HORIZON, stepMinutes = 5) {
  const noon = solarNoonUtcMs(year, month, day, lon);
  let litMinutes = 0;
  for (let m = -720; m < 720; m += stepMinutes) {
    const { azimuth, elevation } = solarPosition(lat, lon, noon + m * 60000);
    if (elevation > Math.max(0, skylineAt(azimuth))) litMinutes += stepMinutes;
  }
  return litMinutes / 60;
}

/**
 * The sun's track across the sky for one date: sampled (azimuth, elevation,
 * utcMs) points where the sun is above (or just below) the horizon plane.
 */
export function sunPathForDay(lat, lon, year, month, day, stepMinutes = 5) {
  const noon = solarNoonUtcMs(year, month, day, lon);
  const points = [];
  for (let m = -720; m <= 720; m += stepMinutes) {
    const utcMs = noon + m * 60000;
    const { azimuth, elevation } = solarPosition(lat, lon, utcMs);
    if (elevation > -3) points.push({ azimuth, elevation, utcMs });
  }
  return points;
}

/**
 * Sun hours on the 21st of every month of a year — the standard sun-path
 * diagram sampling — plus the category each month lands in.
 */
export function monthlyReport(lat, lon, year, skylineAt = OPEN_HORIZON) {
  const report = [];
  for (let month = 1; month <= 12; month++) {
    const hours = sunHoursForDay(lat, lon, year, month, 21, skylineAt);
    report.push({ month, hours, category: categorize(hours) });
  }
  return report;
}
