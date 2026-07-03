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
- **`src/survey.js`** — AR yard-survey math (pure trig, no sensors):
  clinometer sightings → scene obstacles. `sightGroundPoint` (distance from
  the depression angle to an object's base, given eye height),
  `sightHeight`, `spanWidth` (crown from two edge azimuths), `gpsToScene`,
  and `mergeSighting` (repeat sightings running-average, ~1/√n). Assumes
  level-ish ground; accuracy scales with proximity, so the UI pushes users
  to walk close and re-sight.
- **`src/scene.js`** — garden-map scene engine (Phase 2 M1): a top-down
  sketch in world coordinates (units of meters, x east / y north; obstacles:
  `building` polygon footprint + height, `fence` polyline + height, `tree`
  x/y/height/crownWidth/deciduous) → the same solid/leafy skyline layer pair
  app.js spots use, by casting one ray per 1° azimuth bin against the walls
  (nearest hit wins) and reusing `treeProfile` for crowns. `sceneSkylineAt()`
  returns a month-aware skyline that plugs straight into sunhours.js. Has its
  own engine-side `inLeaf(month, lat)` and `layerAt` (app.js's close over UI
  state).
- **`src/sungrid.js`** — whole-garden evaluation (Phase 2 M2):
  `sunSampleTable(lat, lon, year)` precomputes the 21st-of-each-month sun
  positions once (5-min steps, above-horizon only, ~1.7k samples, ~13 ms);
  `sunHoursGrid(scene, grid, table)` sweeps a north-aligned grid, each cell
  carrying all 12 months of hours — so a heatmap month slider needs **no
  recompute**, only sketch edits do (~215 ms for 50×50 cells × 6 obstacles;
  if that's too slow while dragging, use a coarser draft grid, not engine
  hacks). The fast path must stay *bit-for-bit equal* to `sunHoursForDay` —
  an equality test enforces it; the table pre-splits each sample azimuth into
  bin index + fraction using exactly `layerAt`'s arithmetic to keep that true.
- **`src/app.js` + `index.html`** — all state, canvas rendering, and DOM.
  Imports the engine; the engine never imports from here.
- **`src/ar.js` + `ar.html`** — the AR sun view (beta): camera passthrough +
  device-orientation compass/gyro, sun arcs projected via a pinhole model,
  one-tap "align to sun" compass correction, and a sweep spot-check that
  classifies sky pixels along the arcs into per-season sun hours. Sensors,
  camera, and pixel work stay here; it imports only engine modules.
  Orientation (hard-won, field-tested on iPhone — don't regress): the
  gyro-fused *relative* deviceorientation stream drives all motion, with the
  rotation matrix built exactly per event (never smooth alpha/beta/gamma
  separately — the upright pose β≈90° is near gimbal lock and per-angle
  blending causes wild swings). The compass sets the initial yaw reference,
  then may steer only slowly *while the device is still* (rate-gated at
  15°/s) — raw compass headings wander tens of degrees during a pan — and
  "Align to sun" freezes it entirely (gyro + sun fix from then on).
  Also hosts the **📐 yard survey** (math in survey.js): aim at an object's
  base/top/crown edges with the crosshair, ⊕ Mark each — position, height,
  and width land directly in the garden map's `scene.obstacles` (fences:
  base of each post + a height prompt). "📍 I moved" refixes the GPS
  standpoint (walk close to each object — that's where the angles are
  sharp); "⟳ Again" re-sights the last tree and `mergeSighting` averages.
  True azimuth for sightings is `centerDirection().az − state.azOffset`
  (undoing align-to-sun; manual look has no offset).
  Reads/writes the same `"sun-garden"` localStorage key as app.js (lat/lon
  shared; the 💾 Save button appends sweeps to `arChecks` with a fresh GPS
  standpoint, rendered/deleted as a card by app.js). Survey owns the
  `survey` key (eyeHeight) and appends/merges into `scene.obstacles` via
  read-modify-write; the map page reloads scene state on `pageshow`, which
  is what keeps the two writers from clobbering each other. Has a drag-to-look
  fallback when no orientation sensor exists (desktop), and a
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
  that migration behavior when changing the schema. **Storage-ownership
  rule**: app.js owns `lat/lon/active/spots`; ar.js owns `arChecks` (array of
  `{ name, when, lat, lon, days: [{label, hours, coverage}] }`). Each writer
  must merge over the JSON *as stored right now* (`readSaved()`), never a
  load-time snapshot — iOS restores pages from the back-forward cache without
  reloading, and a snapshot write silently deletes the other page's keys
  (this was a real data-loss bug). For the same reason index.html re-renders
  storage-derived UI on `pageshow` with `ev.persisted`.
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

## Status & near-term roadmap (as of 2026-07-03)

**Garden map (top-down shadow simulator, PLAN.md Phase 2) built through M3**
on branch `claude/sungarden-full-map-plan-pw2xlm` (PR #10): M1 scene engine +
M2 sun grid (tested), and M3 the UI — `map.html` + `src/map.js` (third page,
ar.html pattern: imports engine only, owns the `scene` localStorage key under
the storage-ownership rule below; Playwright-verified: draw/edit/move tools,
persistence merge, month slider, shadow movie, scale tool). UX as agreed:
scale set by drawing a line over a known length; optional
satellite-screenshot trace-over (view-fit image, never persisted); heatmap
recomputes live on sketch edits (draft 20×20 grid while dragging, 48×48 on
release; month slider is free — cells carry all 12 months); time-of-day
"shadow movie" via `blockedElevationAt` (one exact ray per cell, no grid);
height presets ("1 story", small/medium/large tree) with tap-to-edit.
**M4 done too**: saved `arChecks` render as calibration pins on the map —
GPS-placed (draggable to correct; overrides live in `scene.pins` keyed by
`check.when`, so ar.js's `arChecks` is never written), green ☀ when measured
hours match the sketch's prediction at that point within 1.25 h, orange ≠
otherwise; sweep rows under 0.4 coverage don't judge; the `Mar / Sep 21`
label compares against whichever equinox month fits better (capture-time
foliage is unknown). The map also has an opt-in **🌍 satellite basemap** (Esri World Imagery
tiles, `server.arcgisonline.com` — attribution drawn on-canvas, consent
confirm explains location is shared with Esri): scale is *derived* from the
web-mercator pyramid (`156543.03392·cos(lat)/2^z` m/px anchored at the
garden's lat/lon), so sketch meters and imagery meters agree with no 📏
calibration — the scale tool is auto-disabled while imagery is live (it
remains the path for 🛰 screenshots). Drag open ground to pan (view center
`viewCx/viewCy`, persisted), **pinch to zoom / two-finger pan in any tool**
(one finger draws, two navigate — an in-flight fence polyline is stashed and
resumed), wheel-zoom about the cursor on desktop, ➕/➖ buttons; tile zoom
self-degrades via `maxTileZoom`, and **over-zoom never blanks the picture**:
close-in planning zooms exceed Esri's real imagery in most neighborhoods,
and past it Esri sometimes 404s but sometimes serves flat gray placeholder
tiles with HTTP 200 (both field-observed). A flat tile alone proves
nothing — real close-in tiles are flat too (lawn/asphalt/roof; that false
positive blanked the map, third field report) — so flat tiles (z≥18) are
held provisional and judged against the same spot in the nearest loaded
ancestor (`resolveFlatTile`): texture there ⇒ placeholder (fall back,
3+ confirmed ⇒ demote the level), flat there too ⇒ real ground (keep).
`drawTileSlot` renders the matching quarter of the nearest available
ancestor scaled up while unresolved/missing (soft, never blank). Heatmap
tint over imagery is 0.38 alpha (0.55 read as "lost the picture" on a
phone). Playwright fixtures for tile stubs must serve *noisy* tiles to
count as real imagery; map8 covers the flat-but-real yard case. Tile-layer wiring is Playwright-verified
against stubbed tiles (the sandbox cannot reach Esri); **live imagery needs
a quick phone/desktop check**. Whole garden-map feature not yet field-tested
on a phone. Known rough edges: no undo on the map page; tree default is
evergreen (conservative); building rectangles are axis-aligned only.

Field-verified on the owner's iPhone 12 Pro: pano loading/zoom/tracing works;
AR arcs are steady while panning (after the motion-gated compass + align-to-
sun rework — owner-confirmed); the sweep spot-check produces per-season
hours. Known rough edges:

- The sweep's sky classifier is a v1 color heuristic (`isSky` in ar.js):
  bright white walls can read as sky, heavy overcast confuses it. PLAN.md §5
  has the v2 path (on-device segmentation).
- Camera FOV is a constant guess (`V_FOV` in ar.js); browsers don't expose
  it. Vertical arc placement is approximate; azimuth is what matters and
  align-to-sun fixes that.
- The arChecks save flow had a bfcache data-loss bug (fixed 2026-07-02, see
  the storage-ownership rule above) — worth re-verifying on device.

Agreed direction from product discussions with the owner (see PRs #5–#7):
the AR spot check is the beginner-friendly front door; the chosen path to
"sun map the whole garden" is the **top-down shadow simulator** (PLAN.md §2
"Complementary method" / Phase 2) — sketch obstacles once, ray-cast shadows,
whole-garden heatmap with a month slider; saved `arChecks` become its
validation data. Other agreed candidates: auto sky segmentation for the pano
tracer. Positioning: free measurement core, one-time Pro unlock, no ads;
differentiators are deciduous awareness, sun-tap calibration, and
plant-language output (PLAN.md §8).

Operational note: GitHub Pages deploys occasionally stick in
`deployment_queued` and time out (happened 2026-07-02, GitHub-side). The
un-cancellable retry blocks `rerun`; the fix is pushing a commit to `main`
(empty is fine) to start a fresh run.

## Workflow authorization

Standing instruction from the repo owner (2026-07-02): **Claude may always
pull and merge on this project without asking** — including merging its own
PRs to `main` (which deploys via GitHub Pages). Merge only work that has been
verified first (unit tests pass; UI changes exercised via Playwright).

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
