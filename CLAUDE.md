# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-dependency static web app that maps direct-sun hours in a garden: the
user traces (or measures) what blocks the sky at each garden spot, and the app
combines that skyline with exact solar-position math to report sun hours for
every month of the year. This is the **Phase 0 prototype** of the larger
product described in `PLAN.md` — read that for the roadmap, method rationale,
and accuracy trade-offs before proposing architectural changes.

## Commands

```sh
npm test                          # all unit tests (node --test, no deps)
node --test test/solar.test.mjs   # a single test file
npm start                         # serve at http://localhost:8000 (python3 http.server;
                                  # any static server works — there is no build step)
```

There is no build, bundler, linter, or framework. Plain ES modules loaded
directly by the browser; `package.json` exists only for the scripts and
`"type": "module"`.

UI changes are verified by serving locally and driving the page with
Playwright (Chromium is preinstalled at `/opt/pw-browsers/chromium` in Claude
Code cloud environments). Unit tests cover only the engine, never the DOM.

## Architecture: engine vs UI

The codebase is split into a pure computational engine (tested) and a UI layer
(untested by unit tests):

- **`src/solar.js`** — NOAA solar position algorithm. Pure functions:
  (lat, lon, UTC ms) → azimuth/elevation, refraction-corrected. No imports.
- **`src/sunhours.js`** — integrates sun paths against a *skyline profile* to
  produce sun hours per day, lit intervals, and 12-month reports.
- **`src/obstacles.js`** — converts measured obstructions (fence height +
  distance, tree crown) into skyline profiles; exists because near obstacles
  a tape measure beats tracing.
- **`src/app.js` + `index.html`** — all state, canvas rendering, and DOM.
  Imports the engine; the engine never imports from here.
- **`src/ar.js` + `ar.html`** — the AR sun view (beta): camera passthrough +
  device-orientation compass/gyro, sun arcs projected via a pinhole model,
  one-tap "align to sun" compass correction, and a sweep spot-check that
  classifies sky pixels along the arcs into per-season sun hours. Sensors,
  camera, and pixel work stay here; it imports only engine modules. Reads
  lat/lon from the same `"sun-garden"` localStorage key as app.js. Has a
  drag-to-look fallback when no orientation sensor exists (desktop), and a
  `window.__arDebug` hook used by Playwright checks.

Keep computation in the engine modules where `node --test` can reach it; the
engine must stay browser/node agnostic (no DOM, no Date.now() side effects in
core math).

### The load-bearing abstraction: skyline profiles

A skyline profile is a function `(azimuth, month) => blockedElevationDegrees`.
Everything composes through it: traced canvas layers, measured obstacles, and
tests all produce one; `sunHoursForDay`/`sunIntervalsForDay`/`monthlyReport`
consume one. The `month` argument exists so deciduous trees block only during
leaf-on months (May–Oct northern hemisphere, flipped southern — see `inLeaf`
in app.js). Engine callers must pass the month of the simulated day through.

### Domain conventions (consistent everywhere)

- Azimuth: degrees clockwise from true north (0=N, 90=E, 180=S, 270=W).
- Elevation: degrees above the horizon; skylines clamp to 0–85.
- Sun-hours integration samples a 24 h window centered on **approximate solar
  noon** (`solarNoonUtcMs`), which avoids any timezone database; times shown
  to users are labeled "local solar time" for the same reason.
- Gardening categories: full sun ≥6 h, part sun ≥4, part shade ≥2, else full
  shade (`CATEGORIES` in sunhours.js).
- Southern hemisphere must keep working (sun tracks through north, seasons
  flip, leaf-on window flips) — there are tests for this; don't hardcode
  northern assumptions.

### UI state model (app.js)

- `state.spots[]`: each spot is `{ name, solid, leafy }` with two
  `Float64Array(360)` skyline layers (1° azimuth bins). Solid always blocks;
  leafy blocks only in leaf. Spots are per-viewpoint on purpose — parallax
  means the same tree subtends different angles from different spots.
- Persistence: JSON in `localStorage` under key `"sun-garden"`. `loadSaved()`
  migrates older shapes (e.g. the original single-`skyline` format); preserve
  that migration behavior when changing the schema.
- **Canvas view window**: the canvas shows a window of the sky (`view` object:
  azStart/azSpan/elMin/elMax). Full sky is 360°×0–90°; loading a panorama
  photo zooms the view to the photo. *All* coordinate mapping goes through
  `xOfAz`/`yOfEl`/`azOfX`/`elOfY` — never map coordinates manually, and note
  azimuth wrap across north is handled by `unwrapAz` (draw code breaks line
  segments on x-jumps > W/2).
- Canvas colors are read from CSS custom properties at draw time
  (`cssVar(...)`), which is how light/dark mode works; chart colors follow the
  validated palette defined in `index.html` `:root` (an ordinal blue ramp for
  the four light categories — validated for color-vision safety; don't swap
  arbitrary hexes in).
- Tracing mutations push onto `undoStack` (`pushUndo()` before any change to
  a spot's layers). New mutation paths must do the same.

### Testing approach

Engine tests are property tests against astronomy landmarks (solstice
declination ±0.3°, equinox sunrise due east, known day lengths, hemisphere
behavior) using tolerance helper `approx()` — not snapshot values. When adding
engine features, test physical invariants (e.g. "blocking never adds sun",
"intervals sum to the integration") rather than exact decimals.

## Deployment

GitHub Pages serves the repo root from `main` at
https://sethanderson004-create.github.io/Sun-garden/ — changes are live a
minute or two after merging to `main`. Everything must keep working as static
files over HTTPS with no server (geolocation requires the HTTPS origin).

**Cache busting is mandatory when shipping changes.** GitHub Pages serves
everything with `max-age=600`, so for up to ~10 minutes after a deploy a
browser can pair a fresh `index.html` with a stale cached module (this once
shipped a "broken" pano zoom: new HTML + old cached app.js, no errors, just
wrong behavior). Every browser-loaded module URL therefore carries a `?v=N`
query — the `<script>` tag in `index.html` and every relative import in
`src/`. When a change touches `index.html` or anything in `src/`, bump N
everywhere in the same commit: `grep -rn '?v=' index.html src/` must show one
consistent number. Node's test runner resolves queried imports fine, so the
tests are unaffected.
