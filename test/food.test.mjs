import test from "node:test";
import assert from "node:assert/strict";
import { parseLog, totalsOf, FOODS } from "../food/parser.js?v=1";

function approx(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? "approx"}: ${actual} not within ${tol} of ${expected}`,
  );
}

test("food database integrity", () => {
  const seen = new Set();
  for (const food of FOODS) {
    assert.ok(food.serving.grams > 0, `${food.name}: serving grams`);
    assert.ok(food.per100.kcal >= 0, `${food.name}: kcal`);
    for (const m of ["p", "c", "f"]) {
      assert.ok(food.per100[m] >= 0, `${food.name}: ${m} nonnegative`);
    }
    // macro energy shouldn't wildly exceed stated kcal (alcohol adds kcal
    // outside p/c/f, so only bound from above)
    const macroKcal = 4 * food.per100.p + 4 * food.per100.c + 9 * food.per100.f;
    assert.ok(
      macroKcal <= food.per100.kcal * 1.35 + 20,
      `${food.name}: macros (${macroKcal.toFixed(0)} kcal) exceed stated ${food.per100.kcal}`,
    );
    for (const alias of [food.name, ...food.aliases]) {
      // aliases may repeat across foods (first wins) but a canonical name may not
      assert.equal(alias, alias.toLowerCase(), `${food.name}: alias lowercase`);
    }
    assert.ok(!seen.has(food.name), `duplicate food ${food.name}`);
    seen.add(food.name);
  }
});

test("simple count: 2 eggs", () => {
  const { items, totals } = parseLog("2 eggs");
  assert.equal(items.length, 1);
  assert.equal(items[0].matched, true);
  assert.equal(items[0].name, "egg");
  approx(totals.kcal, 155, 10, "2 eggs kcal"); // 100 g of egg
  approx(totals.p, 13, 1.5, "2 eggs protein");
});

test("word numbers and splitting: two eggs and a banana", () => {
  const { items, totals } = parseLog("two eggs and a banana");
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "egg");
  assert.equal(items[1].name, "banana");
  approx(totals.kcal, 155 + 105, 15, "kcal");
});

test("weight unit: 100 g chicken breast", () => {
  const { items } = parseLog("100 g chicken breast");
  assert.equal(items[0].name, "chicken breast");
  approx(items[0].kcal, 165, 3, "kcal per 100 g");
  approx(items[0].p, 31, 1, "protein per 100 g");
});

test("ounce conversion: 6 oz of steak", () => {
  const { items } = parseLog("6 oz of steak");
  approx(items[0].grams, 170, 3, "grams");
  approx(items[0].kcal, 461, 15, "kcal");
});

test("volume unit uses food-specific cup weight: half a cup of rice", () => {
  const { items } = parseLog("half a cup of rice");
  assert.equal(items[0].name, "white rice");
  approx(items[0].grams, 80, 2, "half cup cooked rice grams");
  approx(items[0].kcal, 104, 6, "kcal");
});

test("tablespoons: 2 tbsp of peanut butter", () => {
  const { items } = parseLog("2 tbsp of peanut butter");
  assert.equal(items[0].name, "peanut butter");
  approx(items[0].grams, 32, 1, "grams");
  approx(items[0].kcal, 188, 10, "kcal");
});

test("compound aliases survive the splitter", () => {
  const mac = parseLog("a bowl of mac and cheese");
  assert.equal(mac.items.length, 1);
  assert.equal(mac.items[0].name, "mac and cheese");

  const pbj = parseLog("peanut butter and jelly sandwich");
  assert.equal(pbj.items.length, 1);
  assert.equal(pbj.items[0].name, "pbj");
});

test("'with' splits into separate items", () => {
  const { items } = parseLog("toast with butter");
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "toast");
  assert.equal(items[1].name, "butter");
});

test("head-noun bias: chicken burrito is a burrito", () => {
  const { items } = parseLog("a chicken burrito");
  assert.equal(items[0].name, "burrito");
});

test("size modifiers scale servings", () => {
  const small = parseLog("small banana").items[0];
  const plain = parseLog("banana").items[0];
  const large = parseLog("large banana").items[0];
  assert.ok(small.kcal < plain.kcal, "small < plain");
  assert.ok(plain.kcal < large.kcal, "plain < large");
});

test("multi-item meal parses fully and totals equal item sums", () => {
  const { items, totals } = parseLog(
    "two eggs, a slice of toast with butter, and a cup of coffee with milk",
  );
  assert.ok(items.length >= 4, `expected >=4 items, got ${items.map((i) => i.name)}`);
  assert.ok(items.every((i) => i.matched), `unmatched: ${JSON.stringify(items.filter((i) => !i.matched))}`);
  const re = totalsOf(items);
  assert.deepEqual(totals, re, "totals consistent");
  const sum = items.reduce((s, i) => s + i.kcal, 0);
  approx(totals.kcal, sum, 1, "totals = sum of items");
});

test("unknown food is flagged with suggestions, contributes zero", () => {
  const { items, totals } = parseLog("a bowl of xylophone stew");
  assert.equal(items.length, 1);
  assert.equal(items[0].matched, false);
  assert.equal(items[0].kcal, 0);
  assert.ok(Array.isArray(items[0].suggestions));
  assert.equal(totals.kcal, 0);
});

test("plural and singular both match", () => {
  assert.equal(parseLog("3 cookies").items[0].name, "cookie");
  assert.equal(parseLog("1 cookie").items[0].name, "cookie");
  assert.equal(parseLog("strawberry").items[0].name, "strawberries");
});

test("mixed numbers: 1 1/2 cups of pasta", () => {
  const { items } = parseLog("1 1/2 cups of pasta");
  approx(items[0].grams, 210, 3, "1.5 cups cooked pasta");
});

test("'and a half' merges before splitting", () => {
  const { items } = parseLog("two and a half cups of milk");
  assert.equal(items.length, 1);
  approx(items[0].grams, 600, 5, "2.5 cups of milk");
});

test("liquids by the glass", () => {
  const { items } = parseLog("a glass of orange juice");
  assert.equal(items[0].name, "orange juice");
  approx(items[0].kcal, 108, 8, "8 oz OJ");
});

test("quantity scales linearly", () => {
  const one = parseLog("1 slice of pizza").items[0];
  const three = parseLog("3 slices of pizza").items[0];
  approx(three.kcal, one.kcal * 3, 2, "3 slices = 3x kcal");
});

test("common real-world logs all match something sensible", () => {
  const logs = [
    "coffee and a bagel with cream cheese",
    "grilled chicken with rice and broccoli",
    "protein shake after the gym",
    "a beer and some chips",
    "greek yogurt with granola and blueberries",
    "leftover pizza, 2 slices",
    "big bowl of oatmeal with a banana",
    "turkey sandwich and an apple",
  ];
  for (const log of logs) {
    const { items, totals } = parseLog(log);
    const matched = items.filter((i) => i.matched);
    assert.ok(matched.length >= 1, `${log}: nothing matched`);
    assert.ok(totals.kcal > 0, `${log}: zero calories`);
    assert.ok(totals.kcal < 3000, `${log}: absurd total ${totals.kcal}`);
  }
});
