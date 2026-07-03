import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  skylineLayersForPoint,
  sceneSkylineAt,
  blockedElevationAt,
  inLeaf,
  layerAt,
} from '../src/scene.js';
import { fenceProfile } from '../src/obstacles.js';
import { sunHoursForDay, monthlyReport, OPEN_HORIZON } from '../src/sunhours.js';

const DEG = Math.PI / 180;

function approx(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: expected ${expected}±${tol}, got ${actual}`,
  );
}

test('empty scene is an open horizon', () => {
  const { solid, leafy } = skylineLayersForPoint({ obstacles: [] }, 0, 0);
  assert.equal(solid.length, 360);
  assert.equal(leafy.length, 360);
  assert.ok(solid.every((v) => v === 0) && leafy.every((v) => v === 0));
  const at = sceneSkylineAt([], 0, 0, 47.6);
  const open = sunHoursForDay(47.6, -122.3, 2026, 6, 21, OPEN_HORIZON);
  assert.equal(sunHoursForDay(47.6, -122.3, 2026, 6, 21, at), open);
});

test('a long wall matches the analytic fenceProfile taper', () => {
  // 100 m east–west wall, 3 m tall, 10 m north of the viewpoint: squarely
  // faced at azimuth 0, so el(Δ) should follow atan(rise·cosΔ / d).
  const scene = [
    { type: 'fence', points: [{ x: -50, y: 10 }, { x: 50, y: 10 }], height: 3 },
  ];
  const { solid } = skylineLayersForPoint(scene, 0, 0);
  approx(solid[0], Math.atan2(3, 10) / DEG, 0.1, 'square-on elevation');
  const analytic = fenceProfile({ azimuth: 0, distance: 10, height: 3 });
  for (const az of [0, 15, 330, 45, 300, 60]) {
    approx(solid[az], analytic(az), 0.1, `taper at az ${az}`);
  }
  assert.equal(solid[90], 0, 'parallel to the wall: nothing blocked');
  assert.equal(solid[180], 0, 'behind the viewpoint: nothing blocked');
});

test('a finite wall blocks only the arc it subtends', () => {
  // Wall from (5,10) to (15,10): azimuths atan(5/10)≈26.6° to atan(15/10)≈56.3°.
  const scene = [
    { type: 'fence', points: [{ x: 5, y: 10 }, { x: 15, y: 10 }], height: 3 },
  ];
  const { solid } = skylineLayersForPoint(scene, 0, 0);
  assert.ok(solid[40] > 0, 'blocked inside the subtended arc');
  assert.equal(solid[10], 0, 'clear just left of the wall');
  assert.equal(solid[70], 0, 'clear just right of the wall');
  assert.equal(solid[180], 0, 'a wall to the north never costs southern sky');
});

test('blocked elevation falls with distance and with plant height', () => {
  const wall = [
    { type: 'fence', points: [{ x: -50, y: 10 }, { x: 50, y: 10 }], height: 3 },
  ];
  const near = skylineLayersForPoint(wall, 0, 0).solid;
  const far = skylineLayersForPoint(wall, 0, -10).solid;
  assert.ok(far[0] < near[0], 'farther viewpoint sees a lower wall');
  const tall = skylineLayersForPoint(wall, 0, 0, 1.5).solid;
  assert.ok(tall[0] < near[0], 'a taller plant sees a lower wall');
  const over = skylineLayersForPoint(wall, 0, 0, 3.5).solid;
  assert.ok(over.every((v) => v === 0), 'a plant above the wall top sees past it');
});

test('building: full shade inside the footprint, walls outside', () => {
  const house = [
    {
      type: 'building',
      footprint: [{ x: -5, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 20 }, { x: -5, y: 20 }],
      height: 6,
    },
  ];
  const inside = skylineLayersForPoint(house, 0, 15).solid;
  assert.ok(inside.every((v) => v === 85), 'inside the footprint: sky fully blocked');
  assert.equal(sunHoursForDay(47.6, -122.3, 2026, 6, 21, sceneSkylineAt(house, 0, 15, 47.6)), 0);

  const outside = skylineLayersForPoint(house, 0, 0).solid;
  approx(outside[0], Math.atan2(6, 10) / DEG, 0.2, 'nearest wall 10 m due north');
  assert.equal(outside[180], 0, 'southern sky clear');
  // The box subtends atan(5/10) ≈ ±26.6°: az 20 hits the east side wall
  // (farther than the front, so lower), az 30 misses entirely.
  assert.ok(outside[20] > 0 && outside[20] < outside[0], 'side wall hit, lower than front');
  assert.equal(outside[30], 0, 'clear past the near corner');
});

test('azimuth convention: an obstacle due east blocks east, not west', () => {
  const scene = [{ type: 'tree', x: 10, y: 0, height: 8, crownWidth: 6 }];
  const { solid } = skylineLayersForPoint(scene, 0, 0);
  assert.ok(solid[90] > 0, 'blocked toward the east');
  assert.equal(solid[270], 0, 'clear toward the west');
  approx(solid[90], Math.atan2(8, 10) / DEG, 0.5, 'crown top at the trunk azimuth');
});

test('standing under a crown is full shade; a plant above the tree is not', () => {
  const scene = [{ type: 'tree', x: 0, y: 0, height: 8, crownWidth: 6, deciduous: true }];
  const under = skylineLayersForPoint(scene, 0.5, 0);
  assert.ok(under.leafy.every((v) => v === 85), 'under the canopy: leafy layer saturated');
  assert.ok(under.solid.every((v) => v === 0), 'deciduous crown never touches solid');
  const above = skylineLayersForPoint(scene, 0.5, 0, 9);
  assert.ok(above.leafy.every((v) => v === 0), 'plant above the tree top sees open sky');
});

test('deciduous tree: blocks summer, free winter (northern hemisphere)', () => {
  // Big maple 3 m due south of the bed at lat 47.6.
  const scene = [{ type: 'tree', x: 0, y: -3, height: 12, crownWidth: 8, deciduous: true }];
  const at = sceneSkylineAt(scene, 0, 0, 47.6);
  const junOpen = sunHoursForDay(47.6, -122.3, 2026, 6, 21, OPEN_HORIZON);
  const jun = sunHoursForDay(47.6, -122.3, 2026, 6, 21, at);
  assert.ok(jun < junOpen, `in leaf, June loses sun (${jun}h of ${junOpen}h)`);
  const decOpen = sunHoursForDay(47.6, -122.3, 2026, 12, 21, OPEN_HORIZON);
  const dec = sunHoursForDay(47.6, -122.3, 2026, 12, 21, at);
  assert.equal(dec, decOpen, 'bare in December: exactly the open-horizon hours');
});

test('southern hemisphere: leaf-on window and sun direction both flip', () => {
  assert.ok(inLeaf(1, -35) && !inLeaf(7, -35), 'southern leaf-on is Nov–Apr');
  assert.ok(inLeaf(7, 47.6) && !inLeaf(1, 47.6), 'northern leaf-on is May–Oct');
  // At lat −35 the sun tracks through the NORTH, so a deciduous tree due
  // north costs summer (January) sun and leaves winter (July) untouched.
  const scene = [{ type: 'tree', x: 0, y: 3, height: 12, crownWidth: 8, deciduous: true }];
  const at = sceneSkylineAt(scene, 0, 0, -35);
  const janOpen = sunHoursForDay(-35, 151, 2026, 1, 21, OPEN_HORIZON);
  const jan = sunHoursForDay(-35, 151, 2026, 1, 21, at);
  assert.ok(jan < janOpen, `southern summer loses sun (${jan}h of ${janOpen}h)`);
  const julOpen = sunHoursForDay(-35, 151, 2026, 7, 21, OPEN_HORIZON);
  const jul = sunHoursForDay(-35, 151, 2026, 7, 21, at);
  assert.equal(jul, julOpen, 'bare southern winter: open-horizon hours');
});

test('blocking never adds sun, in any month, anywhere in a cluttered yard', () => {
  const scene = [
    {
      type: 'building',
      footprint: [{ x: -8, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 16 }, { x: -8, y: 16 }],
      height: 5,
    },
    { type: 'fence', points: [{ x: -12, y: -12 }, { x: 12, y: -12 }, { x: 12, y: 12 }], height: 1.8 },
    { type: 'tree', x: 8, y: -4, height: 10, crownWidth: 7, deciduous: true },
    { type: 'tree', x: -6, y: -8, height: 6, crownWidth: 4 },
  ];
  const open = monthlyReport(47.6, -122.3, 2026, OPEN_HORIZON);
  for (const [x, y] of [[0, 0], [-3, -6], [7, 2], [10, -10]]) {
    const report = monthlyReport(47.6, -122.3, 2026, sceneSkylineAt(scene, x, y, 47.6));
    assert.equal(report.length, 12);
    report.forEach((r, i) => {
      assert.ok(
        r.hours <= open[i].hours + 1e-9,
        `month ${r.month} at (${x},${y}): ${r.hours}h exceeds open ${open[i].hours}h`,
      );
      assert.ok(r.hours >= 0 && r.category, 'hours non-negative and categorized');
    });
  }
});

test('layers stay within skyline bounds and interpolate smoothly', () => {
  const scene = [
    { type: 'fence', points: [{ x: -2, y: 1 }, { x: 2, y: 1 }], height: 30 },
  ];
  const { solid } = skylineLayersForPoint(scene, 0, 0);
  assert.ok(solid.every((v) => v >= 0 && v <= 85), 'clamped to 0–85');
  approx(layerAt(solid, 359.5), (solid[359] + solid[0]) / 2, 1e-9, 'wraps across north');
});

test('blockedElevationAt agrees with the binned skyline and gates on leaf', () => {
  const scene = [
    {
      type: 'building',
      footprint: [{ x: -8, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 16 }, { x: -8, y: 16 }],
      height: 5,
    },
    { type: 'fence', points: [{ x: -12, y: -12 }, { x: 12, y: -12 }], height: 1.8 },
    { type: 'tree', x: 8, y: -4, height: 10, crownWidth: 7, deciduous: true },
  ];
  const { solid, leafy } = skylineLayersForPoint(scene, 0, 0);
  for (const az of [0, 45, 137, 180, 200, 315]) {
    approx(
      blockedElevationAt(scene, 0, 0, az, true),
      Math.max(layerAt(solid, az), layerAt(leafy, az)),
      0.5,
      `single-ray vs binned at az ${az} (leaf on)`,
    );
    approx(
      blockedElevationAt(scene, 0, 0, az, false),
      layerAt(solid, az),
      0.5,
      `single-ray vs solid-only at az ${az} (leaf off)`,
    );
  }
  // The shadow-movie test itself: sun low in the north-ish sky is behind the
  // house; the same elevation due south is clear.
  assert.ok(blockedElevationAt(scene, 0, 0, 0) > 20, 'house blocks a low northern sun');
  assert.equal(blockedElevationAt(scene, 0, 0, 270), 0, 'western sky open');
});
