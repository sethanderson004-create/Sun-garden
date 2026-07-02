import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunSampleTable, monthlyHoursForLayers, sunHoursGrid } from '../src/sungrid.js';
import { skylineLayersForPoint, sceneSkylineAt } from '../src/scene.js';
import { sunHoursForDay, OPEN_HORIZON } from '../src/sunhours.js';

const CLUTTERED = [
  {
    type: 'building',
    footprint: [{ x: -8, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 16 }, { x: -8, y: 16 }],
    height: 5,
  },
  { type: 'fence', points: [{ x: -12, y: -12 }, { x: 12, y: -12 }, { x: 12, y: 12 }], height: 1.8 },
  { type: 'tree', x: 8, y: -4, height: 10, crownWidth: 7, deciduous: true },
  { type: 'tree', x: -6, y: -8, height: 6, crownWidth: 4 },
];

test('sun table: above-horizon samples only, day length tracks the seasons', () => {
  const t = sunSampleTable(47.6, -122.3, 2026);
  assert.equal(t.months.length, 12);
  for (const { samples } of t.months) {
    assert.ok(samples.length > 0, 'every month has daylight at 47.6°N');
    assert.ok(samples.every((s) => s.elevation > 0), 'no below-horizon samples');
    assert.ok(samples.every((s) => s.azimuth >= 0 && s.azimuth < 360), 'azimuths normalized');
  }
  const june = t.months[5].samples.length;
  const dec = t.months[11].samples.length;
  assert.ok(june > dec, 'northern June day longer than December');

  const s = sunSampleTable(-35, 151, 2026);
  assert.ok(
    s.months[0].samples.length > s.months[6].samples.length,
    'southern January day longer than July',
  );
});

test('grid evaluation matches sunHoursForDay exactly, month by month', () => {
  const table = sunSampleTable(47.6, -122.3, 2026);
  for (const [x, y] of [[0, 0], [7, -3], [-10, 10], [0, 15]]) {
    const fast = monthlyHoursForLayers(skylineLayersForPoint(CLUTTERED, x, y), table);
    const skyline = sceneSkylineAt(CLUTTERED, x, y, 47.6);
    for (let month = 1; month <= 12; month++) {
      const slow = sunHoursForDay(47.6, -122.3, 2026, month, 21, skyline);
      assert.equal(
        fast[month - 1],
        slow,
        `cell (${x},${y}) month ${month}: fast ${fast[month - 1]} vs direct ${slow}`,
      );
    }
  }
});

test('an open grid is uniform and equals the open horizon', () => {
  const table = sunSampleTable(47.6, -122.3, 2026);
  const cells = sunHoursGrid([], { x0: -10, y0: -10, cellSize: 5, cols: 4, rows: 3 }, table);
  assert.equal(cells.length, 12);
  for (let month = 1; month <= 12; month++) {
    const open = sunHoursForDay(47.6, -122.3, 2026, month, 21, OPEN_HORIZON);
    for (const cell of cells) assert.equal(cell.hours[month - 1], open);
  }
});

test('grid geometry: row-major cells, columns east, rows north', () => {
  const cells = sunHoursGrid(
    [],
    { x0: 0, y0: 100, cellSize: 2, cols: 3, rows: 2 },
    sunSampleTable(47.6, -122.3, 2026),
  );
  assert.deepEqual(
    cells.map(({ x, y, col, row }) => ({ x, y, col, row })),
    [
      { x: 1, y: 101, col: 0, row: 0 },
      { x: 3, y: 101, col: 1, row: 0 },
      { x: 5, y: 101, col: 2, row: 0 },
      { x: 1, y: 103, col: 0, row: 1 },
      { x: 3, y: 103, col: 1, row: 1 },
      { x: 5, y: 103, col: 2, row: 1 },
    ],
  );
});

test('the map shows the shadow where the shadow is: north of the house', () => {
  // At 47.6°N the winter sun stays south, so the house shades cells to its
  // north and leaves the mirrored cells to its south untouched.
  const house = [CLUTTERED[0]]; // spans y 6..16, 5 m tall
  const table = sunSampleTable(47.6, -122.3, 2026);
  const north = monthlyHoursForLayers(skylineLayersForPoint(house, -2, 19), table);
  const south = monthlyHoursForLayers(skylineLayersForPoint(house, -2, 3), table);
  const openDec = sunHoursForDay(47.6, -122.3, 2026, 12, 21, OPEN_HORIZON);
  assert.ok(north[11] < south[11], 'December: north cell shadier than south cell');
  assert.equal(south[11], openDec, 'December sun never crosses the house from the south cell');
});

test('plantHeight flows through the grid: above the fence, shade is gone', () => {
  const fence = [
    { type: 'fence', points: [{ x: -50, y: -3 }, { x: 50, y: -3 }], height: 1.8 },
  ];
  const table = sunSampleTable(47.6, -122.3, 2026);
  const grid = { x0: -2, y0: -1, cellSize: 2, cols: 2, rows: 1 };
  const ground = sunHoursGrid(fence, grid, table, 0);
  const above = sunHoursGrid(fence, grid, table, 2);
  const openDec = sunHoursForDay(47.6, -122.3, 2026, 12, 21, OPEN_HORIZON);
  for (let i = 0; i < ground.length; i++) {
    assert.ok(ground[i].hours[11] < openDec, 'ground-level cell loses December sun');
    assert.equal(above[i].hours[11], openDec, 'a plant above the fence top loses nothing');
  }
});
