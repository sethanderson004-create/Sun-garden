import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  die,
  roll,
  rollCharacteristic,
  rollCharacteristics,
  characteristicName,
  damageBonus,
  moveRate,
  deriveAttributes,
  buildOccupation,
  occupationByName,
  rollBackstory,
  rollName,
  makeInvestigator,
  CHARACTERISTICS,
  OCCUPATIONS,
} from '../src/cthulhu.js';

// A tiny deterministic RNG (mulberry32) so tests can pin randomness.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('die stays within [1, sides] across many rolls', () => {
  const rng = seeded(1);
  for (let i = 0; i < 5000; i++) {
    const d = die(6, rng);
    assert.ok(d >= 1 && d <= 6, `d6 out of range: ${d}`);
    assert.equal(d, Math.floor(d), 'die must be an integer');
  }
});

test('roll returns a total equal to the sum of its faces', () => {
  const rng = seeded(2);
  for (let i = 0; i < 1000; i++) {
    const r = roll(3, 6, rng);
    assert.equal(r.faces.length, 3);
    assert.equal(r.total, r.faces.reduce((a, b) => a + b, 0));
    assert.ok(r.total >= 3 && r.total <= 18);
  }
});

test('3d6×5 characteristics land in [15, 90] and multiples of 5', () => {
  const rng = seeded(3);
  for (let i = 0; i < 2000; i++) {
    for (const key of ['STR', 'CON', 'DEX', 'APP', 'POW']) {
      const v = rollCharacteristic(key, rng);
      assert.ok(v >= 15 && v <= 90, `${key} out of range: ${v}`);
      assert.equal(v % 5, 0, `${key} not a multiple of 5: ${v}`);
    }
  }
});

test('(2d6+6)×5 characteristics land in [40, 90]', () => {
  const rng = seeded(4);
  for (let i = 0; i < 2000; i++) {
    for (const key of ['SIZ', 'INT', 'EDU']) {
      const v = rollCharacteristic(key, rng);
      assert.ok(v >= 40 && v <= 90, `${key} out of range: ${v}`);
      assert.equal(v % 5, 0, `${key} not a multiple of 5: ${v}`);
    }
  }
});

test('rollCharacteristics returns all eight named stats', () => {
  const chars = rollCharacteristics(seeded(5));
  assert.deepEqual(Object.keys(chars).sort(), [...CHARACTERISTICS].sort());
  for (const key of CHARACTERISTICS) assert.ok(characteristicName(key).length > 0);
});

test('unknown characteristic throws', () => {
  assert.throws(() => rollCharacteristic('ZZZ', seeded(6)));
});

test('damage bonus table matches the known 7e boundaries', () => {
  // sum = STR+SIZ
  assert.deepEqual(damageBonus(40, 30), { db: '-1', build: -1 }); // 70
  assert.deepEqual(damageBonus(50, 50), { db: '0', build: 0 }); // 100
  assert.deepEqual(damageBonus(70, 60), { db: '+1d4', build: 1 }); // 130
  assert.deepEqual(damageBonus(90, 90), { db: '+1d6', build: 2 }); // 180
  assert.deepEqual(damageBonus(10, 30), { db: '-2', build: -2 }); // 40
});

test('damage bonus extends past the printed table', () => {
  const big = damageBonus(300, 300); // 600 → beyond +4d6 band
  assert.ok(big.build >= 6, `expected build >= 6, got ${big.build}`);
  assert.match(big.db, /d6/);
});

test('move rate reflects STR/DEX vs SIZ and ages down', () => {
  assert.equal(moveRate(40, 40, 80, 30), 7); // both below SIZ
  assert.equal(moveRate(90, 90, 50, 30), 9); // both above SIZ
  assert.equal(moveRate(50, 40, 50, 30), 8); // one meets SIZ
  // aging reduces move; never below 1
  assert.equal(moveRate(90, 90, 50, 40), 8);
  assert.equal(moveRate(90, 90, 50, 80), 4);
  assert.ok(moveRate(40, 40, 80, 89) >= 1);
});

test('derived attributes use the canonical formulas', () => {
  const chars = { STR: 50, CON: 60, SIZ: 70, DEX: 50, APP: 50, INT: 60, POW: 55, EDU: 65 };
  const a = deriveAttributes(chars, 30);
  assert.equal(a.hitPoints, Math.floor((60 + 70) / 10)); // 13
  assert.equal(a.magicPoints, Math.floor(55 / 5)); // 11
  assert.equal(a.sanity, 55); // starts at POW
  assert.equal(a.dodge, Math.floor(50 / 2)); // 25
});

test('blocking sanity: starting sanity never exceeds POW', () => {
  const rng = seeded(7);
  for (let i = 0; i < 500; i++) {
    const chars = rollCharacteristics(rng);
    const a = deriveAttributes(chars, 30);
    assert.equal(a.sanity, chars.POW);
  }
});

test('every occupation produces non-negative skill points and a valid credit rating', () => {
  const rng = seeded(8);
  const chars = { STR: 50, CON: 50, SIZ: 50, DEX: 50, APP: 50, INT: 60, POW: 50, EDU: 70 };
  for (const occ of OCCUPATIONS) {
    const built = buildOccupation(occ.name, chars, rng);
    assert.ok(built.occupationPoints >= 0, `${occ.name} negative points`);
    assert.equal(built.personalInterestPoints, chars.INT * 2);
    const [lo, hi] = occ.creditRating;
    assert.ok(
      built.creditRating >= lo && built.creditRating <= hi,
      `${occ.name} credit ${built.creditRating} outside [${lo},${hi}]`,
    );
    assert.ok(built.skills.length > 0);
  }
});

test('occupationByName and unknown-name guard', () => {
  assert.ok(occupationByName('Professor'));
  assert.equal(occupationByName('Nope'), undefined);
  assert.throws(() => buildOccupation('Nope', {}, seeded(9)));
});

test('rollBackstory fills every narrative slot', () => {
  const b = rollBackstory(seeded(10));
  for (const k of ['ideology', 'significantPerson', 'meaningfulLocation',
    'treasuredPossession', 'trait', 'phobia', 'doom']) {
    assert.equal(typeof b[k], 'string');
    assert.ok(b[k].length > 0, `${k} empty`);
  }
});

test('rollName honors requested gender pool and always has both parts', () => {
  const n = rollName(seeded(11), 'feminine');
  assert.equal(n.gender, 'feminine');
  assert.ok(n.first && n.last);
  assert.equal(n.full, `${n.first} ${n.last}`);
});

test('makeInvestigator is fully populated and deterministic under a fixed seed', () => {
  const a = makeInvestigator({ rng: seeded(42) });
  const b = makeInvestigator({ rng: seeded(42) });
  assert.deepEqual(a, b, 'same seed should yield identical investigators');

  assert.ok(a.name.full.length > 0);
  assert.ok(a.age >= 15 && a.age <= 89);
  assert.equal(Object.keys(a.characteristics).length, 8);
  assert.ok(a.luck >= 15 && a.luck <= 90);
  assert.ok(a.attributes.hitPoints > 0);
  assert.ok(a.occupation.name.length > 0);
  assert.ok(a.backstory.doom.length > 0);
});

test('makeInvestigator respects a requested occupation', () => {
  const inv = makeInvestigator({ rng: seeded(12), occupation: 'Detective' });
  assert.equal(inv.occupation.name, 'Detective');
});
