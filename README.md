# Sun-garden

A phone app to map approximate sun exposure in a garden — measure sun hours for
any spot using the camera, compass, and GPS, then turn that into planting
decisions (what to grow where, when to plant it).

**Core idea:** the sun's position is pure math (GPS + date + time); photos are
only needed to capture what *blocks* it (trees, buildings, fences). A guided
panorama tagged with compass/gyro data yields a skyline profile, and overlaying
the year's sun paths on it gives direct-sun hours for every day of the year.

See [PLAN.md](PLAN.md) for the full feasibility analysis, technical approach,
feature set, and build roadmap.

## Phase 0 prototype (this repo)

A zero-dependency web prototype of the core pipeline: enter a location, trace
your skyline on a panorama canvas (optionally over a photo), and get direct-sun
hours for every month of the year with plant-label light categories.

Features:

- **Multiple spots** — each place you garden (fence bed, veggie patch, porch)
  gets its own named skyline trace, since the same tree fills a different
  amount of sky from each viewpoint. A comparison table summarizes today /
  June / December sun for every spot.
- **Deciduous trees** — a second brush draws tree canopy that only blocks sun
  during leaf-on months (May–Oct in the northern hemisphere), so winter and
  early-spring estimates stay honest.
- **Daily sun timeline** — for any month, see exactly *when* a spot is lit vs
  shaded ("sun until 07:20, tree shade until 09:10, sun again to 15:00…").

```sh
npm start        # serves on http://localhost:8000 (any static server works)
npm test         # unit tests for the solar engine (node --test)
```

- `src/solar.js` — NOAA solar position algorithm (azimuth/elevation for any
  location and time), pure functions, no dependencies.
- `src/sunhours.js` — skyline profile + sun path → direct-sun hours per day,
  monthly report, gardening light categories.
- `src/app.js`, `index.html` — the tracing canvas, sun-path overlay, and
  monthly report UI. State persists in `localStorage`.
