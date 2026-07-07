// Meal-text parser: natural spoken phrases → matched foods with estimated
// calories and macros. Pure module (no DOM, no Date) so node --test covers it.
//
//   parseLog("two eggs and a slice of toast with butter")
//     → { items: [ {name, qty, grams, kcal, p, c, f, matched, ...} ], totals }
//
// Estimates are deliberately approximate: the goal is a consistent,
// low-friction ballpark that keeps the user logging, not label precision.

import { FOODS } from "./foods.js?v=1";

// --- quantity words ---------------------------------------------------------

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  couple: 2, few: 3, several: 3, half: 0.5, quarter: 0.25,
};

const SIZE_MULT = {
  small: 0.7, little: 0.7, mini: 0.5,
  medium: 1, regular: 1, normal: 1,
  large: 1.35, big: 1.35, huge: 1.6, giant: 1.6, "extra large": 1.6, xl: 1.6,
  double: 2,
};

// Units that mean an explicit amount. kind: "g" factor → grams directly;
// "cup"/"tbsp"/"tsp"/"glass"/"handful" look at the food; "count" = servings.
const UNITS = {
  g: { g: 1 }, gram: { g: 1 }, grams: { g: 1 },
  kg: { g: 1000 }, kilo: { g: 1000 }, kilogram: { g: 1000 }, kilograms: { g: 1000 },
  oz: { g: 28.35 }, ounce: { g: 28.35 }, ounces: { g: 28.35 },
  lb: { g: 453.6 }, lbs: { g: 453.6 }, pound: { g: 453.6 }, pounds: { g: 453.6 },
  ml: { g: 1 }, milliliter: { g: 1 }, milliliters: { g: 1 },
  l: { g: 1000 }, liter: { g: 1000 }, liters: { g: 1000 }, litre: { g: 1000 }, litres: { g: 1000 },
  cup: { kind: "cup" }, cups: { kind: "cup" },
  tbsp: { kind: "tbsp" }, tablespoon: { kind: "tbsp" }, tablespoons: { kind: "tbsp" },
  tsp: { kind: "tsp" }, teaspoon: { kind: "tsp" }, teaspoons: { kind: "tsp" },
  glass: { kind: "glass" }, glasses: { kind: "glass" }, mug: { kind: "glass" }, mugs: { kind: "glass" },
  pint: { kind: "pint" }, pints: { kind: "pint" },
  handful: { kind: "handful" }, handfuls: { kind: "handful" },
  slice: { kind: "count" }, slices: { kind: "count" },
  piece: { kind: "count" }, pieces: { kind: "count" },
  can: { kind: "count" }, cans: { kind: "count" },
  bottle: { kind: "count" }, bottles: { kind: "count" },
  bowl: { kind: "count" }, bowls: { kind: "count" },
  plate: { kind: "count" }, plates: { kind: "count" },
  scoop: { kind: "count" }, scoops: { kind: "count" },
  bar: { kind: "count" }, bars: { kind: "count" },
  link: { kind: "count" }, links: { kind: "count" },
  shot: { kind: "count" }, shots: { kind: "count" },
  serving: { kind: "count" }, servings: { kind: "count" },
  order: { kind: "count" }, side: { kind: "count" },
};

// Filler words dropped from food names before matching. Deliberately does NOT
// include words that are part of food names (hot, fried, ice, sweet...).
const FILLER = new Set([
  "of", "the", "some", "my", "a", "an", "fresh", "organic", "plain",
  "leftover", "homemade", "more", "another", "just", "about", "roughly",
  "around", "approximately", "like", "maybe",
]);

// --- alias index ------------------------------------------------------------

function buildIndex(foods) {
  const exact = new Map();
  const entries = []; // { tokens, food }
  const compounds = []; // multi-word aliases containing split words
  for (const food of foods) {
    for (const alias of [food.name, ...food.aliases]) {
      const norm = alias.toLowerCase();
      if (!exact.has(norm)) exact.set(norm, food);
      entries.push({ alias: norm, tokens: norm.split(" "), food });
      if (/\b(and|with|plus)\b/.test(norm)) compounds.push(norm);
    }
  }
  compounds.sort((a, b) => b.length - a.length);
  return { exact, entries, compounds };
}

let defaultIndex = null;
function indexFor(foods) {
  if (foods === FOODS) return (defaultIndex ??= buildIndex(FOODS));
  return buildIndex(foods);
}

function singular(word) {
  if (word.length > 3 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokensMatch(a, b) {
  if (a === b) return 1;
  if (singular(a) === singular(b)) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.8;
  return 0;
}

// Fuzzy match: token overlap, with a bias toward the head noun (last token)
// so "chicken burrito" resolves to burrito, not chicken.
function fuzzyMatch(name, index) {
  const qTokens = name.split(" ");
  const scored = [];
  for (const { tokens, food } of index.entries) {
    let overlap = 0;
    let lastMatchedQ = -1;
    for (const t of tokens) {
      let best = 0, bestQ = -1;
      for (let qi = 0; qi < qTokens.length; qi++) {
        const m = tokensMatch(t, qTokens[qi]);
        if (m > best) { best = m; bestQ = qi; }
      }
      overlap += best;
      if (best > 0 && bestQ > lastMatchedQ) lastMatchedQ = bestQ;
    }
    if (overlap === 0) continue;
    let score = (2 * overlap) / (qTokens.length + tokens.length);
    if (overlap >= tokens.length) score += 0.25; // alias fully inside query
    if (overlap >= qTokens.length) score += 0.15; // query fully inside alias
    score += 0.02 * (lastMatchedQ / qTokens.length); // head-noun bias
    scored.push({ score, food });
  }
  scored.sort((a, b) => b.score - a.score);
  // de-dup foods keeping best score
  const seen = new Set();
  const ranked = [];
  for (const s of scored) {
    if (seen.has(s.food.name)) continue;
    seen.add(s.food.name);
    ranked.push(s);
  }
  return ranked;
}

// --- segment parsing --------------------------------------------------------

function parseNumberAt(tokens, i) {
  const t = tokens[i];
  if (t === undefined) return null;
  let m;
  if ((m = t.match(/^(\d+)\/(\d+)$/))) return { value: +m[1] / +m[2], next: i + 1 };
  if (/^\d+(\.\d+)?$/.test(t)) {
    // "1 1/2" mixed number
    const frac = tokens[i + 1]?.match(/^(\d+)\/(\d+)$/);
    if (frac) return { value: +t + +frac[1] / +frac[2], next: i + 2 };
    return { value: +t, next: i + 1 };
  }
  if (t in NUM_WORDS) {
    // "half a", "half an", "a half"
    if (t === "a" && tokens[i + 1] === "half") return { value: 0.5, next: i + 2 };
    if (t === "half" && (tokens[i + 1] === "a" || tokens[i + 1] === "an")) {
      return { value: 0.5, next: i + 2 };
    }
    if (t === "couple" || t === "few" || t === "several") {
      const next = tokens[i + 1] === "of" ? i + 2 : i + 1;
      return { value: NUM_WORDS[t], next };
    }
    return { value: NUM_WORDS[t], next: i + 1 };
  }
  return null;
}

function gramsFor(food, qty, unit, sizeMult) {
  const s = food.serving.grams;
  if (!unit) return qty * s * sizeMult;
  const u = UNITS[unit];
  if (u.g) return qty * u.g; // explicit weight/volume — size words don't apply
  switch (u.kind) {
    case "cup": return qty * (food.cup ?? (food.liquid ? 240 : 130));
    case "tbsp": return qty * (food.tbsp ?? 15);
    case "tsp": return qty * (food.tsp ?? (food.tbsp ? food.tbsp / 3 : 5));
    case "glass": return qty * (food.liquid ? 240 : s) * sizeMult;
    case "pint": return qty * (food.liquid ? 473 : s) * sizeMult;
    case "handful": return qty * (food.handful ?? 30) * sizeMult;
    default: return qty * s * sizeMult; // count-ish units ≈ one serving
  }
}

function parseSegment(segment, index) {
  const tokens = segment.split(" ").filter(Boolean);
  if (!tokens.length) return null;

  let i = 0;
  let qty = 1;
  let explicitQty = false;
  const num = parseNumberAt(tokens, i);
  if (num) { qty = num.value; i = num.next; explicitQty = true; }
  if (tokens[i] === "of") i++;

  let sizeMult = 1;
  if (tokens[i] in SIZE_MULT && i + 1 < tokens.length) {
    sizeMult = SIZE_MULT[tokens[i]];
    i++;
  }

  let unit = null;
  if (tokens[i] in UNITS && i + 1 < tokens.length) {
    unit = tokens[i];
    i++;
    if (tokens[i] === "of") i++;
    // size after unit: "a cup of large..." is odd, but "a large cup of" handled above
  }

  const nameTokens = tokens.slice(i).filter((t) => !FILLER.has(t));
  if (!nameTokens.length) return null;
  const name = nameTokens.join(" ");

  let food = index.exact.get(name) ?? null;
  let suggestions = [];
  if (!food) {
    const ranked = fuzzyMatch(name, index);
    if (ranked.length && ranked[0].score >= 0.6) food = ranked[0].food;
    else suggestions = ranked.slice(0, 3).map((r) => r.food.name);
  }

  if (!food) {
    return {
      text: segment, name, qty, unit, sizeMult, matched: false, suggestions,
      grams: 0, kcal: 0, p: 0, c: 0, f: 0,
    };
  }

  const grams = gramsFor(food, qty, unit, sizeMult);
  const k = grams / 100;
  return {
    text: segment,
    name: food.name,
    qty, unit, sizeMult, explicitQty,
    matched: true,
    grams: Math.round(grams),
    kcal: Math.round(food.per100.kcal * k),
    p: Math.round(food.per100.p * k * 10) / 10,
    c: Math.round(food.per100.c * k * 10) / 10,
    f: Math.round(food.per100.f * k * 10) / 10,
    servingLabel: food.serving.label,
  };
}

// --- public API -------------------------------------------------------------

export function totalsOf(items) {
  const t = { kcal: 0, p: 0, c: 0, f: 0 };
  for (const it of items) {
    t.kcal += it.kcal; t.p += it.p; t.c += it.c; t.f += it.f;
  }
  t.kcal = Math.round(t.kcal);
  t.p = Math.round(t.p * 10) / 10;
  t.c = Math.round(t.c * 10) / 10;
  t.f = Math.round(t.f * 10) / 10;
  return t;
}

export function parseLog(text, foods = FOODS) {
  const index = indexFor(foods);

  let norm = text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s./,;]/g, " ")
    .replace(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten) and a half/g,
      (_, n) => String((NUM_WORDS[n] ?? +n) + 0.5))
    .replace(/\s+/g, " ")
    .trim();

  // Protect compound aliases ("mac and cheese", "coffee with milk") from the
  // segment splitter by joining their words with underscores.
  for (const compound of index.compounds) {
    if (norm.includes(compound)) {
      norm = norm.split(compound).join(compound.replace(/ /g, "_"));
    }
  }

  const segments = norm
    .split(/\s*,\s*|\s*;\s*|\s+and\s+|\s+with\s+|\s+plus\s+|\s+then\s+|\s+also\s+/)
    .map((s) => s.replace(/_/g, " ").trim())
    .filter(Boolean);

  const items = [];
  for (const seg of segments) {
    const item = parseSegment(seg, index);
    if (item) items.push(item);
  }
  return { items, totals: totalsOf(items) };
}

export { FOODS };
