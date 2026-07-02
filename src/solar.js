/**
 * Solar position engine — NOAA solar position algorithm.
 * Pure functions, no dependencies; accurate to well under 0.1° for
 * 1900–2100, far beyond what garden sun mapping needs.
 *
 * Angle conventions:
 *   azimuth   — degrees clockwise from true north (0 = N, 90 = E, 180 = S, 270 = W)
 *   elevation — degrees above the horizon (refraction-corrected)
 */

const RAD = Math.PI / 180;

function mod(n, m) {
  return ((n % m) + m) % m;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Julian day from a UTC timestamp in milliseconds. */
export function toJulianDay(utcMs) {
  return utcMs / 86400000 + 2440587.5;
}

/**
 * NOAA atmospheric refraction correction, in degrees, for a true
 * (geometric) elevation in degrees.
 */
export function refractionCorrection(elevation) {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * RAD);
  let corr; // arcseconds
  if (elevation > 5) {
    corr = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  } else if (elevation > -0.575) {
    corr =
      1735 +
      elevation *
        (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  } else {
    corr = -20.774 / te;
  }
  return corr / 3600;
}

/**
 * Sun position for an observer.
 *
 * @param {number} lat  latitude in degrees (north positive)
 * @param {number} lon  longitude in degrees (east positive)
 * @param {number} utcMs  UTC timestamp in milliseconds
 * @returns {{azimuth: number, elevation: number, declination: number, eqTimeMinutes: number}}
 */
export function solarPosition(lat, lon, utcMs) {
  const jc = (toJulianDay(utcMs) - 2451545) / 36525; // Julian century

  const meanLong = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360);
  const meanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);

  const eqOfCenter =
    Math.sin(meanAnom * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * meanAnom * RAD) * 0.000289;

  const trueLong = meanLong + eqOfCenter;
  const omega = 125.04 - 1934.136 * jc; // longitude of ascending lunar node
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const meanObliq =
    23 +
    (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * RAD);

  const declination =
    Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD)) / RAD;

  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const eqTimeMinutes =
    (4 / RAD) *
    (y * Math.sin(2 * meanLong * RAD) -
      2 * eccent * Math.sin(meanAnom * RAD) +
      4 * eccent * y * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD) -
      0.5 * y * y * Math.sin(4 * meanLong * RAD) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * RAD));

  const minutesPastUtcMidnight = mod(utcMs, 86400000) / 60000;
  const trueSolarTime = mod(minutesPastUtcMidnight + eqTimeMinutes + 4 * lon, 1440);
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const cosZenith =
    Math.sin(lat * RAD) * Math.sin(declination * RAD) +
    Math.cos(lat * RAD) * Math.cos(declination * RAD) * Math.cos(hourAngle * RAD);
  const zenith = Math.acos(clamp(cosZenith, -1, 1)) / RAD;

  const elevation = 90 - zenith + refractionCorrection(90 - zenith);

  let azimuth;
  const denom = Math.cos(lat * RAD) * Math.sin(zenith * RAD);
  if (Math.abs(denom) > 1e-9) {
    const azArg = clamp(
      (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(declination * RAD)) /
        denom,
      -1,
      1,
    );
    const acosAz = Math.acos(azArg) / RAD;
    azimuth = hourAngle > 0 ? mod(acosAz + 180, 360) : mod(540 - acosAz, 360);
  } else {
    // Sun at the zenith/nadir or observer at a pole: azimuth is degenerate.
    azimuth = lat > 0 ? 180 : 0;
  }

  return { azimuth, elevation, declination, eqTimeMinutes };
}

/**
 * Approximate UTC timestamp of solar noon for a calendar date at a longitude.
 * Good to a few minutes, which is plenty for centering a sampling window.
 */
export function solarNoonUtcMs(year, month, day, lon) {
  return Date.UTC(year, month - 1, day, 12) - (lon / 15) * 3600000;
}
