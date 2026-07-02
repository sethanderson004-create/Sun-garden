import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenceProfile, treeProfile, paintProfile } from '../src/obstacles.js';
import { sunHoursForDay, OPEN_HORIZON } from '../src/sunhours.js';

function approx(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: expected ${expected}±${tol}, got ${actual}`,
  );
}

test('fence elevation depends dramatically on viewing height', () => {
  // 1.8 m fence, 0.75 m away, due south.
  const fromHedge = fenceProfile({ azimuth: 180, distance: 0.75, height: 1.8, plantHeight: 0.6 });
  approx(fromHedge(180), 58, 1, 'from a 0.6 m hedge: atan(1.2/0.75)');

  const fromEye = fenceProfile({ azimuth: 180, distance: 0.75, height: 1.8, plantHeight: 1.7 });
  approx(fromEye(180), 7.6, 1, 'from eye height: atan(0.1/0.75)');
});

test('fence profile tapers along its length and ends at ±90°', () => {
  const f = fenceProfile({ azimuth: 180, distance: 0.75, height: 1.8, plantHeight: 0.6 });
  approx(f(240), Math.atan2(1.2 * 0.5, 0.75) / (Math.PI / 180), 1, '60° off-square: cos taper');
  assert.equal(f(90), 0, 'parallel to the fence: nothing blocked');
  assert.equal(f(0), 0, 'behind the observer: nothing blocked');
  assert.ok(f(180) > f(210) && f(210) > f(240), 'monotone taper off-square');
});

test('tree profile: elliptical bump with correct top and width', () => {
  const t = treeProfile({ azimuth: 200, distance: 10, height: 12, crownWidth: 8, plantHeight: 0.5 });
  approx(t(200), Math.atan2(11.5, 10) / (Math.PI / 180), 0.5, 'crown top at center');
  const halfW = Math.atan2(4, 10) / (Math.PI / 180);
  assert.equal(t(200 + halfW + 1), 0, 'zero just past the crown edge');
  assert.ok(t(200 + halfW / 2) < t(200), 'lower toward the edge');
});

test('degenerate inputs block nothing', () => {
  assert.equal(fenceProfile({ azimuth: 180, distance: 1, height: 0.5, plantHeight: 0.6 })(180), 0);
  assert.equal(treeProfile({ azimuth: 0, distance: 0, height: 5, crownWidth: 3 })(0), 0);
});

test('paintProfile max-merges into an existing skyline', () => {
  const arr = new Float64Array(360).fill(10);
  paintProfile(arr, (az) => (az === 180 ? 40 : 0));
  assert.equal(arr[180], 40, 'higher profile wins');
  assert.equal(arr[90], 10, 'existing skyline kept elsewhere');
});

test('the hedge-by-the-fence scenario: winter starved, summer untouched', () => {
  // Seattle-ish latitude, 1.8 m fence due south, hedge 0.6 m at 0.75 m away.
  const fence = fenceProfile({ azimuth: 180, distance: 0.75, height: 1.8, plantHeight: 0.6 });
  const dec = sunHoursForDay(47.6, -122.3, 2026, 12, 21, fence);
  const mar = sunHoursForDay(47.6, -122.3, 2026, 3, 21, fence);
  const marOpen = sunHoursForDay(47.6, -122.3, 2026, 3, 21, OPEN_HORIZON);
  const jun = sunHoursForDay(47.6, -122.3, 2026, 6, 21, fence);
  const junOpen = sunHoursForDay(47.6, -122.3, 2026, 6, 21, OPEN_HORIZON);
  assert.equal(dec, 0, 'December sun (peak ~19°) never clears the 58° fence');
  assert.ok(mar < 2 && mar < marOpen, `equinox mostly blocked (${mar}h of ${marOpen}h open)`);
  // In June the sun is higher than the fence's cos-taper at every azimuth,
  // so midsummer loses nothing — the squeeze is spring/fall/winter.
  approx(jun, junOpen, 0.2, 'June unaffected by the south fence');
});
