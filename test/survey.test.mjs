import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groundDistance,
  sightGroundPoint,
  sightHeight,
  spanWidth,
  gpsToScene,
  mergeSighting,
} from '../src/survey.js';

const DEG = Math.PI / 180;

function approx(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: expected ${expected}±${tol}, got ${actual}`,
  );
}

test('clinometer distance: steeper down-angle means closer', () => {
  // eye 1.6 m, looking 9.09° below the horizon → 10 m (tan 9.09° ≈ 0.16)
  approx(groundDistance(1.6, -9.0903), 10, 0.05, 'the textbook case');
  approx(groundDistance(1.6, -17.744), 5, 0.05, 'closer = steeper');
  assert.ok(groundDistance(1.6, -4.574) > 19, 'shallower = farther');
  assert.equal(groundDistance(1.6, 0), null, 'horizon never meets the ground');
  assert.equal(groundDistance(1.6, 5), null, 'above the horizon is not the ground');
  assert.equal(groundDistance(0, -10), null, 'needs a real eye height');
});

test('ground sighting lands in the right compass direction', () => {
  const east = sightGroundPoint({ x: 0, y: 0 }, 1.6, 90, -9.0903);
  approx(east.x, 10, 0.05, 'due east: +x');
  approx(east.y, 0, 0.05, 'due east: no y');
  const north = sightGroundPoint({ x: 2, y: 3 }, 1.6, 0, -17.744);
  approx(north.x, 2, 0.05, 'due north from an offset standpoint: x kept');
  approx(north.y, 8, 0.05, 'due north: +5 y');
  assert.equal(sightGroundPoint({ x: 0, y: 0 }, 1.6, 90, 3), null, 'sky sight rejected');
});

test('height from a top sighting, round-trip against the setup', () => {
  // A tree 8 m tall, 10 m away, eye 1.6 m: top sits at atan(6.4/10) = 32.62°
  approx(sightHeight(1.6, 10, 32.6188), 8, 0.02, 'recovers the true height');
  approx(sightHeight(1.6, 10, 0), 1.6, 1e-9, 'level sight = eye height');
  assert.equal(sightHeight(1.6, 5, -80), 0, 'clamped at the ground');
});

test('crown width from two edge azimuths, wrap-safe', () => {
  // 4 m crown at 10 m: half-width atan(2/10) = 11.31° each side
  approx(spanWidth(10, 90 - 11.3099, 90 + 11.3099), 4, 0.02, 'symmetric edges');
  approx(spanWidth(10, 355, 5), 10 * 2 * Math.tan(5 * DEG), 0.02, 'across north');
  assert.equal(spanWidth(10, 120, 120), 0, 'zero span');
});

test('gps deltas map to scene meters like the map page pins', () => {
  const lat = 47.6062;
  const east10 = gpsToScene(lat, -122.3321, lat, -122.3321 + 10 / (110574 * Math.cos(lat * DEG)));
  approx(east10.x, 10, 0.01, '10 m east');
  approx(east10.y, 0, 0.01, 'no northing');
  const north7 = gpsToScene(lat, -122.3321, lat + 7 / 110574, -122.3321);
  approx(north7.y, 7, 0.01, '7 m north');
});

test('repeat sightings average with correct weights', () => {
  const first = { type: 'tree', x: 10, y: 0, height: 8, crownWidth: 4, sightings: 1 };
  const second = mergeSighting(first, { x: 11, y: 1, height: 9, crownWidth: 5 });
  assert.equal(second.sightings, 2);
  approx(second.x, 10.5, 1e-9, 'mean of two');
  const third = mergeSighting(second, { x: 12.5, y: 0.5, height: 7, crownWidth: 4.5 });
  assert.equal(third.sightings, 3);
  approx(third.x, (10 + 11 + 12.5) / 3, 1e-9, 'weighted running mean');
  approx(third.height, (8 + 9 + 7) / 3, 1e-9, 'height averaged too');
  assert.equal(third.type, 'tree', 'non-numeric fields untouched');
});
