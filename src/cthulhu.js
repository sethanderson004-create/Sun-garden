// Call of Cthulhu (7th edition) investigator generator — pure engine.
//
// No DOM, no imports, no global side effects. All randomness flows through an
// injectable `rng` (a function returning a float in [0, 1), like Math.random),
// so tests are deterministic and the whole thing is browser/node agnostic —
// same split as the rest of this repo (engine tested, UI not).
//
// Everything a fun character needs comes out of one call to
// `makeInvestigator()`: rolled characteristics, derived attributes (HP, MP,
// Sanity, Luck, Move, damage bonus/build, Dodge), an era-appropriate name, an
// occupation with a themed skill spread, and a randomly-drawn backstory
// (ideology, that one significant person, a phobia, a treasured possession, an
// ominous hook). Individual pieces can be re-rolled from the UI by calling the
// smaller builders directly.

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

/** One integer in [1, sides]. */
export function die(sides, rng = Math.random) {
  return 1 + Math.floor(rng() * sides);
}

/** Sum of `n` dice of `sides` faces, returned with the individual faces. */
export function roll(n, sides, rng = Math.random) {
  const faces = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const f = die(sides, rng);
    faces.push(f);
    total += f;
  }
  return { total, faces };
}

/** Pick one element of `arr` uniformly. */
export function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

// ---------------------------------------------------------------------------
// Characteristics (7e: rolls are ×5 so the scale runs 0–99)
// ---------------------------------------------------------------------------

// STR/CON/DEX/APP/POW/LUCK = 3d6×5  (15–90, mean ~52).
// SIZ/INT/EDU              = (2d6+6)×5 (40–90, mean ~65).
const CHAR_ROLLS = {
  STR: (rng) => roll(3, 6, rng).total * 5,
  CON: (rng) => roll(3, 6, rng).total * 5,
  DEX: (rng) => roll(3, 6, rng).total * 5,
  APP: (rng) => roll(3, 6, rng).total * 5,
  POW: (rng) => roll(3, 6, rng).total * 5,
  SIZ: (rng) => (roll(2, 6, rng).total + 6) * 5,
  INT: (rng) => (roll(2, 6, rng).total + 6) * 5,
  EDU: (rng) => (roll(2, 6, rng).total + 6) * 5,
};

export const CHARACTERISTICS = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];

const CHAR_NAMES = {
  STR: 'Strength',
  CON: 'Constitution',
  SIZ: 'Size',
  DEX: 'Dexterity',
  APP: 'Appearance',
  INT: 'Intelligence',
  POW: 'Power',
  EDU: 'Education',
};

export function characteristicName(key) {
  return CHAR_NAMES[key] || key;
}

/** Roll one characteristic by key (e.g. re-rolling a single stat). */
export function rollCharacteristic(key, rng = Math.random) {
  const roller = CHAR_ROLLS[key];
  if (!roller) throw new Error(`unknown characteristic: ${key}`);
  return roller(rng);
}

/** Roll the full set of eight characteristics. */
export function rollCharacteristics(rng = Math.random) {
  const out = {};
  for (const key of CHARACTERISTICS) out[key] = rollCharacteristic(key, rng);
  return out;
}

// ---------------------------------------------------------------------------
// Derived attributes
// ---------------------------------------------------------------------------

// Damage bonus & Build from STR+SIZ (7e table). Each +80 past the top band
// adds another 1d6 of damage and +1 Build.
const DB_BANDS = [
  { max: 64, db: '-2', build: -2 },
  { max: 84, db: '-1', build: -1 },
  { max: 124, db: '0', build: 0 },
  { max: 164, db: '+1d4', build: 1 },
  { max: 204, db: '+1d6', build: 2 },
  { max: 284, db: '+2d6', build: 3 },
  { max: 364, db: '+3d6', build: 4 },
  { max: 444, db: '+4d6', build: 5 },
];

export function damageBonus(str, siz) {
  const sum = str + siz;
  for (const band of DB_BANDS) {
    if (sum <= band.max) return { db: band.db, build: band.build };
  }
  // Beyond the printed table: +1d6 and +1 Build per additional 80 points.
  const over = Math.floor((sum - 444) / 80) + 1;
  return { db: `+${4 + over}d6`, build: 5 + over };
}

/** Base Move rate from STR/DEX vs SIZ, then aged down. */
export function moveRate(str, dex, siz, age) {
  let mov;
  if (dex < siz && str < siz) mov = 7;
  else if (str > siz && dex > siz) mov = 9;
  else mov = 8; // one of them meets or beats SIZ
  if (age >= 80) mov -= 5;
  else if (age >= 70) mov -= 4;
  else if (age >= 60) mov -= 3;
  else if (age >= 50) mov -= 2;
  else if (age >= 40) mov -= 1;
  return Math.max(1, mov);
}

/** HP, MP, Sanity, Move, damage bonus/build, Dodge from characteristics. */
export function deriveAttributes(chars, age = 30) {
  const hp = Math.floor((chars.CON + chars.SIZ) / 10);
  const mp = Math.floor(chars.POW / 5);
  const san = chars.POW; // starting Sanity equals POW
  const { db, build } = damageBonus(chars.STR, chars.SIZ);
  const mov = moveRate(chars.STR, chars.DEX, chars.SIZ, age);
  const dodge = Math.floor(chars.DEX / 2);
  return {
    hitPoints: hp,
    maxHitPoints: hp,
    magicPoints: mp,
    sanity: san,
    maxSanity: 99,
    damageBonus: db,
    build,
    move: mov,
    dodge,
  };
}

// ---------------------------------------------------------------------------
// Age (7e: age affects EDU, and young/old characters trade points around).
// We keep the flavor without the full modifier bookkeeping the tabletop does
// by hand; characteristics are rolled fresh and age drives Move + descriptor.
// ---------------------------------------------------------------------------

const AGE_BANDS = [
  { min: 15, max: 19, label: 'a green youth' },
  { min: 20, max: 29, label: 'in their restless twenties' },
  { min: 30, max: 39, label: 'settled but curious' },
  { min: 40, max: 49, label: 'seasoned and wary' },
  { min: 50, max: 59, label: 'grey at the temples' },
  { min: 60, max: 69, label: 'old enough to know better' },
  { min: 70, max: 89, label: 'ancient, and still asking questions' },
];

export function rollAge(rng = Math.random) {
  // Weighted toward the classic 20s–40s adventurer.
  const age = 20 + roll(2, 6, rng).total + die(6, rng) - 3; // ~19–45 centered
  return Math.min(89, Math.max(15, age));
}

export function ageDescriptor(age) {
  const band = AGE_BANDS.find((b) => age >= b.min && age <= b.max);
  return band ? band.label : 'of indeterminate years';
}

// ---------------------------------------------------------------------------
// Names — 1920s / Jazz Age flavor
// ---------------------------------------------------------------------------

const FIRST_NAMES = {
  feminine: ['Eleanor', 'Florence', 'Adelaide', 'Beatrice', 'Cordelia', 'Vivian',
    'Harriet', 'Josephine', 'Winifred', 'Margaret', 'Agnes', 'Dorothea',
    'Constance', 'Sylvia', 'Mabel', 'Ruth', 'Iris', 'Nora', 'Clara', 'Estelle'],
  masculine: ['Arthur', 'Ambrose', 'Edwin', 'Percival', 'Reginald', 'Silas',
    'Herbert', 'Walter', 'Cyrus', 'Randolph', 'Oswald', 'Julius',
    'Nathaniel', 'Cornelius', 'Elias', 'Roland', 'Frederick', 'Harvey',
    'Lucius', 'Bartholomew'],
  neutral: ['Morgan', 'Frances', 'Marion', 'Jean', 'Leslie', 'Vivian',
    'Sidney', 'Dana', 'Robin', 'Jamie'],
};

const SURNAMES = ['Ashcroft', 'Blackwood', 'Carmody', 'Delacroix', 'Fairbanks',
  'Grimsby', 'Hollis', 'Ingram', 'Latimer', 'Marsh', 'Nightingale', 'Osgood',
  'Pembrooke', 'Quimby', 'Radcliffe', 'Sterling', 'Thorne', 'Underwood',
  'Vanderlin', 'Whateley', 'Armitage', 'Peaslee', 'Wilmarth', 'Gilman',
  'Derby', 'Pickman', 'Halsey', 'Corwin', 'Waite', 'Orne'];

export function rollName(rng = Math.random, gender) {
  const g = gender || pick(['feminine', 'masculine', 'neutral'], rng);
  const pool = FIRST_NAMES[g] || FIRST_NAMES.neutral;
  const first = pick(pool, rng);
  const last = pick(SURNAMES, rng);
  return { first, last, full: `${first} ${last}`, gender: g };
}

// ---------------------------------------------------------------------------
// Occupations — a themed spread of classic pulp archetypes.
//   creditRating: [min, max] rating for the occupation
//   skillFormula: how occupation skill points are computed from characteristics
//   skills: signature skills for the archetype
//   emoji / blurb: flavor for the UI
// ---------------------------------------------------------------------------

export const OCCUPATIONS = [
  {
    name: 'Antiquarian',
    emoji: '📜',
    creditRating: [30, 70],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Appraise', 'Library Use', 'History', 'Other Language', 'Spot Hidden',
      'Art/Craft (any)', 'Navigate', 'Persuade'],
    blurb: 'Collector of the old and the forbidden. Knows which relics should have stayed buried.',
  },
  {
    name: 'Author',
    emoji: '✒️',
    creditRating: [9, 30],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Art (Literature)', 'History', 'Library Use', 'Natural World',
      'Occult', 'Other Language', 'Own Language', 'Psychology'],
    blurb: 'Sees the horror clearly enough to write it down — which may be the problem.',
  },
  {
    name: 'Detective',
    emoji: '🔍',
    creditRating: [20, 50],
    skillFormula: (c) => c.EDU * 2 + Math.max(c.DEX, c.STR) * 2,
    skills: ['Art/Craft (Acting)', 'Disguise', 'Firearms (Handgun)', 'Law',
      'Listen', 'Psychology', 'Spot Hidden', 'Stealth'],
    blurb: 'Follows the evidence past the point where sane people stop following.',
  },
  {
    name: 'Doctor of Medicine',
    emoji: '⚕️',
    creditRating: [30, 80],
    skillFormula: (c) => c.EDU * 4,
    skills: ['First Aid', 'Medicine', 'Biology', 'Other Language (Latin)',
      'Psychology', 'Science (Pharmacy)', 'Persuade', 'Spot Hidden'],
    blurb: 'Has seen what a body can survive — and what walks in wearing one.',
  },
  {
    name: 'Dilettante',
    emoji: '🥂',
    creditRating: [50, 99],
    skillFormula: (c) => c.APP * 2 + c.EDU * 2,
    skills: ['Art/Craft (any)', 'Firearms (Rifle/Shotgun)', 'Other Language',
      'Ride', 'Charm', 'Drive Auto', 'Spot Hidden', 'Appraise'],
    blurb: 'Rich, bored, and dangerously willing to fund an expedition to the wrong island.',
  },
  {
    name: 'Journalist',
    emoji: '📰',
    creditRating: [9, 30],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Art/Craft (Photography)', 'History', 'Own Language', 'Library Use',
      'Fast Talk', 'Psychology', 'Persuade', 'Spot Hidden'],
    blurb: 'Chasing the story that every editor already warned them to drop.',
  },
  {
    name: 'Occultist',
    emoji: '🔮',
    creditRating: [9, 65],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Anthropology', 'History', 'Library Use', 'Occult',
      'Other Language', 'Science (Astronomy)', 'Spot Hidden', 'Cthulhu Mythos'],
    blurb: 'Reads the star-charts nobody prints anymore. Already knows too much.',
  },
  {
    name: 'Parapsychologist',
    emoji: '👻',
    creditRating: [9, 30],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Anthropology', 'Art/Craft (Photography)', 'History', 'Library Use',
      'Occult', 'Other Language', 'Psychology', 'Spot Hidden'],
    blurb: 'Insists the haunting is real. This time, catastrophically, they are right.',
  },
  {
    name: 'Police Detective',
    emoji: '🚔',
    creditRating: [20, 50],
    skillFormula: (c) => c.EDU * 2 + Math.max(c.DEX, c.STR) * 2,
    skills: ['Firearms (Handgun)', 'Law', 'Listen', 'Psychology', 'Fighting (Brawl)',
      'Spot Hidden', 'Fast Talk', 'Drive Auto'],
    blurb: 'Homicide, mostly. Some of these cases do not close.',
  },
  {
    name: 'Private Investigator',
    emoji: '🕵️',
    creditRating: [9, 30],
    skillFormula: (c) => c.EDU * 2 + Math.max(c.DEX, c.STR) * 2,
    skills: ['Art/Craft (Photography)', 'Disguise', 'Law', 'Library Use',
      'Fast Talk', 'Locksmith', 'Psychology', 'Spot Hidden'],
    blurb: 'Cheap office, cheaper whiskey, an instinct for doors that should stay shut.',
  },
  {
    name: 'Professor',
    emoji: '🎓',
    creditRating: [20, 70],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Library Use', 'Other Language', 'Own Language', 'Psychology',
      'History', 'Science (any)', 'Anthropology', 'Persuade'],
    blurb: 'Tenured, respected, and about to translate something they should not.',
  },
  {
    name: 'Missionary',
    emoji: '✝️',
    creditRating: [0, 30],
    skillFormula: (c) => c.EDU * 2 + Math.max(c.APP, c.POW) * 2,
    skills: ['Art/Craft (any)', 'Medicine', 'First Aid', 'Mechanical Repair',
      'Natural World', 'Other Language', 'Persuade', 'Psychology'],
    blurb: 'Carried the faith to the far places. Something out there was listening.',
  },
  {
    name: 'Soldier',
    emoji: '🎖️',
    creditRating: [9, 30],
    skillFormula: (c) => c.EDU * 2 + Math.max(c.DEX, c.STR) * 2,
    skills: ['Firearms (Rifle/Shotgun)', 'Fighting (Brawl)', 'Dodge', 'Stealth',
      'Survival (any)', 'First Aid', 'Climb', 'Mechanical Repair'],
    blurb: 'Came home from the trenches. The war never quite ended for them.',
  },
  {
    name: 'Alienist',
    emoji: '🛋️',
    creditRating: [10, 60],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Law', 'Listen', 'Medicine', 'Other Language',
      'Psychology', 'Psychoanalysis', 'Science (Biology)', 'Persuade'],
    blurb: 'Studies the deranged for a living — and is starting to envy their certainty.',
  },
  {
    name: 'Archaeologist',
    emoji: '⛏️',
    creditRating: [10, 40],
    skillFormula: (c) => c.EDU * 4,
    skills: ['Appraise', 'Archaeology', 'History', 'Other Language',
      'Library Use', 'Spot Hidden', 'Mechanical Repair', 'Navigate'],
    blurb: 'Digs where the locals warn them not to. The locals are usually right.',
  },
  {
    name: 'Drifter',
    emoji: '🚂',
    creditRating: [0, 5],
    skillFormula: (c) => c.EDU * 2 + Math.max(c.APP, c.DEX, c.STR) * 2,
    skills: ['Climb', 'Jump', 'Listen', 'Navigate', 'Stealth',
      'Streetwise', 'Fast Talk', 'Locksmith'],
    blurb: 'No fixed address, no one to miss them. Which is exactly why they got picked.',
  },
];

export function occupationByName(name) {
  return OCCUPATIONS.find((o) => o.name === name);
}

/** Occupation skill points, personal-interest points, and rolled credit rating. */
export function buildOccupation(occupation, chars, rng = Math.random) {
  const occ = typeof occupation === 'string' ? occupationByName(occupation) : occupation;
  if (!occ) throw new Error(`unknown occupation: ${occupation}`);
  const occupationPoints = Math.max(0, Math.round(occ.skillFormula(chars)));
  const personalInterestPoints = chars.INT * 2;
  const [lo, hi] = occ.creditRating;
  const creditRating = lo + Math.floor(rng() * (hi - lo + 1));
  return {
    name: occ.name,
    emoji: occ.emoji,
    blurb: occ.blurb,
    skills: occ.skills.slice(),
    occupationPoints,
    personalInterestPoints,
    creditRating,
  };
}

// ---------------------------------------------------------------------------
// Backstory (7e-style) — the tables that make a sheet feel like a person.
// ---------------------------------------------------------------------------

const IDEOLOGIES = [
  'There is a purpose to it all — a design behind the veil, and it is watching.',
  'Science is the only lamp in the dark; superstition is how the weak surrender.',
  'The universe is indifferent, and only what we build for each other has meaning.',
  'Every debt is repaid in the end. Yours is coming due.',
  'Knowledge is the highest good, whatever it costs the one who carries it.',
  'The old faith of my family protects me — so long as I keep its rites.',
  'The dead are not gone; they wait, and they remember.',
  'Fortune favors the bold, and I have never been anything else.',
  'Order must be preserved at any price. Chaos is the true enemy.',
  'There are doors humanity was never meant to open. I intend to open one anyway.',
];

const SIGNIFICANT_PEOPLE = [
  'a mentor who vanished on an expedition and was never spoken of again',
  'a sibling committed to Arkham Sanitarium, whose letters have grown strange',
  'a childhood friend who now leads a congregation you do not recognize',
  'a lover lost at sea off Innsmouth — whose body was never recovered',
  'the professor who first showed you the book, and warned you to close it',
  'a parent whose deathbed confession you have never dared repeat',
  'a business partner who owes you everything and fears you utterly',
  'a stranger who saved your life once and asked for nothing — yet',
  'a rival scholar you would give anything to prove wrong',
  'the family servant who raised you and knows all the house’s secrets',
];

const MEANINGFUL_LOCATIONS = [
  'the reading room of the Orne Library at Miskatonic University',
  'a clifftop lighthouse where the fog never quite lifts',
  'the family estate outside Arkham, half its rooms shuttered',
  'a jazz cellar in Boston where nobody asks your name',
  'the ruined chapel on the moor, where you first heard the singing',
  'a steamer cabin bound for a port that isn’t on the charts',
  'the university lecture hall where your certainties came apart',
  'a fishing village whose people all share the same unblinking stare',
  'the attic room where you found the trunk that started everything',
  'a mountain pass in the Andes, above the line where birds turn back',
];

const TREASURED_POSSESSIONS = [
  'a pocket watch that stopped the night your father died — and has never restarted',
  'a battered field journal, three pages torn out by your own hand',
  'a service revolver, one chamber you keep loaded and pray you never need',
  'a locket holding a photograph you can no longer bear to look at',
  'a fragment of green stone that is always faintly warm to the touch',
  'a first-edition book in a language no living scholar admits to knowing',
  'a silver key of unknown make that fits no lock you have ever tried',
  'a child’s drawing that predicted something before it happened',
  'a train ticket to a town that burned down forty years ago',
  'a ring taken from a corpse that was not, strictly speaking, human',
];

const TRAITS = [
  'unfailingly polite, even to things that do not deserve it',
  'incapable of leaving a puzzle unsolved',
  'quietly generous, and mortified to be caught at it',
  'a compulsive note-taker who trusts ink over memory',
  'brave to the point of foolishness when others are in danger',
  'haunted by dreams they refuse to describe',
  'devoted to a pet that seems to sense what they cannot',
  'a collector of small superstitions — salt over the shoulder, no thirteenth step',
  'unshakably loyal, and slow to forgive a betrayal',
  'given to long silences that unnerve everyone in the room',
];

const PHOBIAS = [
  'Nyctophobia — the dark, and what patience it hides',
  'Thalassophobia — deep water, and the shapes suggested beneath it',
  'Claustrophobia — enclosed spaces, tombs and cellars worst of all',
  'Bibliophobia — certain books, which they cannot bring themselves to touch',
  'Ornithophobia — birds, ever since the flock that would not scatter',
  'Autophobia — being alone, truly alone, where no one would hear',
  'Nosophobia — contagion, the idea of something growing inside them',
  'Selenophobia — the full moon, and what they did the last one',
];

const DOOMS = [
  'A pattern of coincidences is closing around them like a net.',
  'They have already read one word too many; the dreams have started.',
  'Someone — or something — has written their name in a ledger they’ll never see.',
  'The thing they are searching for has begun searching back.',
  'Their luck is not luck. It is being spent on their behalf, for a price.',
  'A door in their childhood home has stayed locked for a reason.',
  'Every clock they own is now three minutes fast. No one else’s is.',
  'They will be offered exactly what they want. That is the trap.',
];

export function rollBackstory(rng = Math.random) {
  return {
    ideology: pick(IDEOLOGIES, rng),
    significantPerson: pick(SIGNIFICANT_PEOPLE, rng),
    meaningfulLocation: pick(MEANINGFUL_LOCATIONS, rng),
    treasuredPossession: pick(TREASURED_POSSESSIONS, rng),
    trait: pick(TRAITS, rng),
    phobia: pick(PHOBIAS, rng),
    doom: pick(DOOMS, rng),
  };
}

// ---------------------------------------------------------------------------
// The whole investigator
// ---------------------------------------------------------------------------

/**
 * Build a complete investigator.
 * @param {object} [opts]
 * @param {() => number} [opts.rng] random source in [0,1)
 * @param {string} [opts.occupation] occupation name; random if omitted
 * @param {string} [opts.gender] 'feminine' | 'masculine' | 'neutral'; random if omitted
 * @param {number} [opts.age] fixed age; rolled if omitted
 */
export function makeInvestigator(opts = {}) {
  const rng = opts.rng || Math.random;
  const chars = rollCharacteristics(rng);
  const age = opts.age != null ? opts.age : rollAge(rng);
  const attributes = deriveAttributes(chars, age);
  const name = rollName(rng, opts.gender);
  const occ = opts.occupation
    ? occupationByName(opts.occupation)
    : pick(OCCUPATIONS, rng);
  const occupation = buildOccupation(occ, chars, rng);
  const backstory = rollBackstory(rng);
  const luck = roll(3, 6, rng).total * 5;
  return {
    name,
    age,
    ageDescriptor: ageDescriptor(age),
    characteristics: chars,
    luck,
    attributes,
    occupation,
    backstory,
  };
}
