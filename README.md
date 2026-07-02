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
