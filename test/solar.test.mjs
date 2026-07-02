import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, solarNoonUtcMs } from '../src/solar.js';
import {
  sunIntervalsForDay,
  sunHoursForDay,
  sunPathForDay,
  monthlyReport,
  categorize,
  OPEN_HORIZON,
} from '../src/sunhours.js';

function approx(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: expected ${expected}±${tol}, got ${actual}`,
  );
}

test('solar declination hits the solstice/equinox landmarks', () => {
  const jun = solarPosition(0, 0, Date.UTC(2026, 5, 21, 12));
  approx(jun.declination, 23.43, 0.3, 'June solstice declination');

  const dec = solarPosition(0, 0, Date.UTC(2026, 11, 21, 12));
  approx(dec.declination, -23.43, 0.3, 'December solstice declination');

  const mar = solarPosition(0, 0, Date.UTC(2026, 2, 20, 12));
  approx(mar.declination, 0, 0.5, 'March equinox declination');
});

test('solar noon elevation matches 90 - |lat - declination|', () => {
  // Lat 40N, June 21: declination ~23.4 → noon elevation ~73.4.
  const noon = solarNoonUtcMs(2026, 6, 21, -105);
  const p = solarPosition(40, -105, noon);
  approx(p.elevation, 90 - (40 - p.declination), 0.5, 'noon elevation at 40N');
  approx(p.azimuth, 180, 3, 'noon azimuth points due south at 40N');
});

test('on the equinox the sun rises very near due east', () => {
  // Scan the morning of Mar 20 2026 at lat 45 for the horizon crossing.
  const noon = solarNoonUtcMs(2026, 3, 20, 0);
  let riseAz = null;
  for (let m = -720; m < 0; m += 2) {
    const p = solarPosition(45, 0, noon + m * 60000);
    if (riseAz === null && p.elevation > 0) riseAz = p.azimuth;
  }
  assert.ok(riseAz !== null, 'sun rose');
  approx(riseAz, 90, 3, 'equinox sunrise azimuth');
});

test('day length: ~12h at the equator, long northern days in June', () => {
  approx(sunHoursForDay(0, 0, 2026, 3, 21), 12, 0.4, 'equator equinox');
  // Berlin (52.5N): June 21 daylight is about 16.8h.
  approx(sunHoursForDay(52.5, 13.4, 2026, 6, 21), 16.8, 0.6, 'Berlin June');
  // ...and about 7.6h on Dec 21.
  approx(sunHoursForDay(52.5, 13.4, 2026, 12, 21), 7.6, 0.6, 'Berlin December');
});

test('southern hemisphere: sun tracks through the north, June is winter', () => {
  const noon = solarNoonUtcMs(2026, 6, 21, 151);
  const p = solarPosition(-33.9, 151.2, noon); // Sydney
  approx(p.azimuth, 0, 5, 'Sydney June noon sun is due north');
  const june = sunHoursForDay(-33.9, 151.2, 2026, 6, 21);
  const dec = sunHoursForDay(-33.9, 151.2, 2026, 12, 21);
  assert.ok(june < dec, `June (${june}h) shorter than December (${dec}h) in Sydney`);
});

test('skyline blocking reduces sun hours as expected', () => {
  const open = sunHoursForDay(45, 0, 2026, 12, 21, OPEN_HORIZON);

  // Fully walled in: no sun at all.
  const walled = sunHoursForDay(45, 0, 2026, 12, 21, () => 89);
  assert.equal(walled, 0, 'a 89° skyline blocks everything');

  // A 70° wall across the whole southern half: at 45N in December the sun
  // never exceeds ~22° elevation and stays in the south → zero hours.
  const southWall = (az) => (az > 90 && az < 270 ? 70 : 0);
  const decBehindWall = sunHoursForDay(45, 0, 2026, 12, 21, southWall);
  assert.equal(decBehindWall, 0, 'December sun fully blocked by south wall');

  // In June the sun rises NE and sets NW, so some hours survive the wall.
  const junBehindWall = sunHoursForDay(45, 0, 2026, 6, 21, southWall);
  assert.ok(junBehindWall > 1, `June keeps some sun (got ${junBehindWall}h)`);
  assert.ok(open > decBehindWall, 'blocking never adds sun');
});

test('sun path points are plausible and sorted through the day', () => {
  const path = sunPathForDay(47.6, -122.3, 2026, 6, 21);
  assert.ok(path.length > 100, 'plenty of samples on a long day');
  const maxEl = Math.max(...path.map((p) => p.elevation));
  approx(maxEl, 90 - (47.6 - 23.43), 0.8, 'peak elevation in Seattle in June');
  for (const p of path) {
    assert.ok(p.azimuth >= 0 && p.azimuth < 360, 'azimuth in range');
  }
});

test('monthly report covers 12 months with sane categories', () => {
  const report = monthlyReport(47.6, -122.3, 2026);
  assert.equal(report.length, 12);
  for (const r of report) {
    assert.ok(r.hours >= 0 && r.hours <= 24);
    assert.ok(r.category.name.length > 0);
  }
  // Open horizon in Seattle: every month clears the full-sun bar.
  assert.equal(report[5].category.name, 'Full sun');
});

test('categorize maps hours to plant-label buckets', () => {
  assert.equal(categorize(8).name, 'Full sun');
  assert.equal(categorize(5).name, 'Part sun');
  assert.equal(categorize(3).name, 'Part shade');
  assert.equal(categorize(0.5).name, 'Full shade');
});

test('deciduous obstruction: blocks in leaf, transparent in winter', () => {
  // A "leafy tree" wall across the south at 45N: counts May–Oct only.
  const inLeaf = (month) => month >= 5 && month <= 10;
  const leafySouthWall = (az, month) =>
    inLeaf(month) && az > 90 && az < 270 ? 70 : 0;

  const decOpen = sunHoursForDay(45, 0, 2026, 12, 21, OPEN_HORIZON);
  const decLeafy = sunHoursForDay(45, 0, 2026, 12, 21, leafySouthWall);
  assert.equal(decLeafy, decOpen, 'bare tree in December blocks nothing');

  const junOpen = sunHoursForDay(45, 0, 2026, 6, 21, OPEN_HORIZON);
  const junLeafy = sunHoursForDay(45, 0, 2026, 6, 21, leafySouthWall);
  assert.ok(junLeafy < junOpen - 4, `tree in leaf costs June hours (${junOpen} -> ${junLeafy})`);
});

test('sun intervals: a midday-blocking tree splits the day in two', () => {
  const southWall = (az) => (az > 90 && az < 270 ? 70 : 0);
  const intervals = sunIntervalsForDay(47, 0, 2026, 6, 21, southWall);
  assert.ok(intervals.length >= 2, `expected morning+evening light, got ${intervals.length} interval(s)`);
  assert.ok(intervals[0].endMin < 0 && intervals.at(-1).startMin > 0, 'lit before and after solar noon');

  // Interval minutes must agree with the sun-hours integration.
  const total = intervals.reduce((s, iv) => s + (iv.endMin - iv.startMin), 0) / 60;
  const hours = sunHoursForDay(47, 0, 2026, 6, 21, southWall);
  assert.ok(Math.abs(total - hours) < 0.35, `intervals (${total}h) match integration (${hours}h)`);
});
