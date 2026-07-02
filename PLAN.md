# Sun-Garden: Phone-Based Garden Sun Mapping — Feasibility & Product Plan

## 1. The Big Question: How Possible Is This?

**Verdict: Very possible.** In fact, the hardest-looking part — knowing where the sun
is — is the *easiest* part, and the approach below is already proven by existing tools
(Sun Seeker, Solmetric SunEye, Solar Pathfinder, Photographer's Ephemeris). None of
them, however, are built for gardeners, and none turn the data into planting decisions.
That's the opportunity.

### The key insight

You don't need photos to know where the sun is. **The sun's position in the sky is
100% deterministic** given latitude, longitude, date, and time — computable with
well-known astronomy formulas (the NOAA solar position algorithm) accurate to a
fraction of a degree. A phone's GPS gives us lat/lon for free.

What we *can't* compute is what **blocks** the sun at a given spot: trees, the
house, the neighbor's fence. That's what photos (plus the phone's compass and
gyroscope) are for.

So the problem decomposes into two clean halves:

| Half | Source | Difficulty |
|---|---|---|
| Where is the sun at every minute of every day of the year? | Math + GPS | Solved — textbook astronomy |
| What obstructs the sky from this spot in the garden? | Photos + phone sensors | Moderate — proven technique |

Combine the two and you get, for any spot: **direct-sun hours per day, for every
day of the year** — which is exactly what plant labels ask for ("full sun, 6+ hours").

### Why "approximate" is good enough

Gardening doesn't need solar-engineering precision. Plants care about categories:

- **Full sun**: 6+ hours direct sun
- **Part sun**: 4–6 hours
- **Part shade**: 2–4 hours
- **Full shade**: < 2 hours

Phone compass error (±5–10°) and rough sky segmentation might shift an estimate by
±30–45 minutes of sun per day. That almost never changes the *category*, so the
result stays actionable. We should still design for the error sources (see §6).

---

## 2. Core Method: The Skyline Profile ("Sun Path Panorama")

This is the heart of the app, and it's the same principle professional solar-site
assessors use ($300+ hardware tools) — we replicate it with a phone.

### How it works, step by step

1. **Stand at the spot** you want to assess (e.g., the middle of a planned bed).
2. **Guided panorama capture**: the app walks the user through a slow 360° sweep
   (or just the sun-relevant arc — roughly east through south to west in the
   northern hemisphere). Each camera frame is tagged with the phone's
   **compass azimuth** and **gyroscope/accelerometer pitch**, so every pixel maps
   to a direction in the sky (azimuth, elevation).
3. **Sky segmentation**: classify each pixel as *sky* or *obstruction*. Start with
   simple color/brightness heuristics + an editable brush for the user to fix
   mistakes; upgrade to a small on-device ML segmentation model later. The output
   is a **skyline profile**: for each compass azimuth, the elevation angle below
   which the sky is blocked.
4. **Overlay the sun's paths**: compute the sun's (azimuth, elevation) track for
   the 21st of each month. For every 5-minute step of every day, check: is the sun
   above or below the skyline at that azimuth?
5. **Output**: direct-sun hours for that spot — today, in June, in October, over
   the whole season — plus a beautiful visual of the sun arcs drawn over the
   user's own panorama photo.

### Repeat for multiple spots → garden heatmap

Capture 3–8 spots around the garden and the app interpolates a **sun heatmap**
overlaid on a sketch or satellite view of the yard: green = full sun,
yellow = part sun, blue = shade. This is the "wow" artifact users will screenshot
and share.

### Complementary method: obstacle sketching (no panorama needed)

For users who want an answer for a garden they can't stand in yet (planning a new
bed, buying a house), offer a **top-down shadow simulator**:

- Show a satellite/map view (or a blank grid) of the property.
- The user draws obstacles: house footprint + height, trees (position, height,
  canopy width, evergreen vs deciduous), fences.
- The app ray-casts shadows for any date/time and animates them through the day —
  a "shadow movie" — and computes the same sun-hours heatmap.

This is pure geometry (sun elevation + object height → shadow length and
direction), needs no camera, and cross-validates the panorama method.

### Bonus method: AR live view

Point the camera anywhere and see the sun's arc for any chosen date drawn over the
live camera feed ("here's where the sun will travel on March 21"). Cheap to build
once the sensor math exists, and a great instant-gratification feature.

### What about detecting shadows directly from photos?

Analyzing shadows in ordinary photos (time-lapse of the yard) sounds natural but is
the *weakest* approach: it's defeated by clouds, only tells you about the moment
the photo was taken, and inferring year-round sun from one day's shadows is
error-prone. We keep it as an optional Phase-3 "verify my estimate" feature
(user leaves phone propped in a window, app samples frames across a sunny day),
not the core method. **The skyline method gives the whole year from 2 minutes of
capture; shadow watching gives one day from 8 hours.**

---

## 3. Role of Location Data

Location is load-bearing throughout:

| Data | Derived from | Used for |
|---|---|---|
| Latitude/longitude | GPS (or address entry) | Sun path computation — the foundation of everything |
| Timezone & DST | lat/lon | Displaying local solar times correctly |
| Magnetic declination | World Magnetic Model lookup | Correcting compass readings to true north (critical — off by up to ~15° in parts of the US) |
| Hardiness zone (USDA or equivalent) | lat/lon lookup table | Plant recommendations |
| Average first/last frost dates | lat/lon climate dataset | Planting calendar |
| Historical cloud cover (optional) | Climate normals API | Converting "geometric" sun hours to realistic expected sun hours |
| Terrain horizon (optional) | Digital elevation model API | Auto-filling distant hills/mountains into the skyline |

Privacy note: everything works with a one-time coarse location grab; no tracking
needed. Compute on device; location never has to leave the phone for the core
features.

---

## 4. Full Feature Set

### Tier 1 — Sun mapping (the core)

1. **Spot Check**: stand anywhere, do the guided panorama, get sun hours for that
   spot (today / by month / annual average) with the sun-category label
   ("Part Sun — 4.5 hrs in June, 2 hrs in October").
2. **Sun arcs over your photo**: monthly sun paths drawn on the user's own
   panorama — instantly understandable.
3. **Garden Sun Map**: multi-spot capture → interpolated heatmap over a satellite
   or sketched garden view, with a **month slider** (watch your sunny June bed turn
   shady in September).
4. **Shadow Simulator**: sketch obstacles top-down, animate shadows for any
   date/time.
5. **AR Sun Path**: live camera overlay of the sun's track for any date.
6. **Deciduous awareness**: mark obstructions as "leafy tree" — the app treats
   them as transparent November–April, giving honest early-spring sun estimates
   (crucial for spring crops and bulbs).

### Tier 2 — Turning sun data into gardening decisions

7. **Plant matcher**: a plant database tagged with light needs, hardiness zone,
   and days-to-maturity. Tap a spot on the heatmap → "What can I grow here?"
   Or search a plant → "Where in my garden will tomatoes thrive?" (best-spot
   finder).
8. **Bed planner**: draw beds on the sun map, drag plants into them; the app
   warns on mismatches ("basil in a 3-hr spot will sulk").
9. **Planting calendar**: from frost dates + zone + chosen plants, generate
   sow-indoors / transplant / direct-sow / harvest windows, with notification
   reminders.
10. **Season extension hints**: "this bed gets full sun until Oct 20 — good
    candidate for a fall lettuce succession."

### Tier 3 — Ongoing gardening companion

11. **Garden journal**: photo log per bed/plant, notes, automatic date + weather
    stamping; year-over-year comparison.
12. **Task engine**: watering suggestions weighted by each bed's sun exposure +
    live weather (a full-sun bed needs water sooner than the shade bed);
    fertilizing/pruning schedules per plant.
13. **Verify mode**: the optional propped-phone time-lapse that measures actual
    light on a given day and tunes the model.
14. **Sharing & community**: share your sun map / garden plan; neighborhood zone
    tips; "gardens near me growing this successfully."
15. **Pro export**: PDF site report (skyline chart, monthly sun-hour table) —
    useful for landscape designers and solar-panel shoppers, a natural
    paid feature.

---

## 5. Technical Architecture

### Recommended stack

- **App**: React Native + Expo (one codebase for iOS/Android; camera, GPS,
  magnetometer, gyroscope all available via Expo modules). Flutter is an equally
  valid choice; React Native picked for ecosystem breadth.
  - A **PWA won't cut it for capture**: browser compass/orientation APIs are
    inconsistent (especially iOS). A web companion app can still view/share maps.
- **Solar engine**: implement the NOAA solar position algorithm in TypeScript
  (or use the battle-tested `suncalc` library as a starting point). Pure
  functions, fully unit-testable against published ephemeris data. Runs on
  device, offline.
- **Sky segmentation**:
  - *v1*: color-space heuristic (sky is high-luminance, blue/white-dominant,
    connected to top of frame) + user touch-up brush. Ship this first — user
    correction makes accuracy a non-issue.
  - *v2*: small on-device semantic segmentation model (e.g., a MobileNet-based
    sky segmenter via TensorFlow Lite / Core ML). Sky segmentation is one of the
    easiest segmentation tasks; public datasets exist (ADE20K, SkyFinder).
- **Sensor fusion**: fuse compass + gyroscope (complementary filter) during the
  panorama sweep so momentary magnetic disturbances don't corrupt azimuth tags;
  apply magnetic declination correction from the World Magnetic Model.
- **Storage**: offline-first, local SQLite; optional cloud sync (Supabase or
  Firebase) for accounts, backup, and sharing.
- **Data**: plant database (start with a curated ~200-vegetable/herb/flower CSV;
  grow via open datasets like USDA PLANTS / OpenFarm), frost-date and hardiness
  lookups bundled offline.

### The core computation (for the record)

```
for each day-of-interest (e.g., 21st of each month):
    for t in sunrise..sunset step 5 min:
        (azimuth, elevation) = solar_position(lat, lon, date, t)
        if elevation > skyline_elevation_at(azimuth):
            direct_sun_minutes += 5
```

Skyline profile = array of (azimuth → blocked-elevation) sampled every 1–2°,
extracted from the tagged panorama. Everything downstream (categories, heatmap,
plant matching) hangs off this table. Cheap enough to run on-device in
milliseconds.

---

## 6. Accuracy: Error Sources & Mitigations

| Error source | Impact | Mitigation |
|---|---|---|
| Compass error (±5–10°, worse near metal) | Sun-hour estimate shifts ~±20–40 min | Declination correction; gyro fusion; calibration prompt; let user drag the panorama to align with a visible sun/shadow ("the sun is HERE right now" one-tap calibration — kills most azimuth error) |
| Sky segmentation mistakes | Misclassified branches/wires | Manual touch-up brush; conservative defaults; v2 ML model |
| Deciduous trees | Winter/spring sun badly underestimated if captured in summer | "Leafy tree" tagging (§4.6); prompt seasonal re-capture |
| Clouds & diffuse light | Geometric sun-hours ≠ actual photons | Report both "clear-sky hours" and climate-adjusted expectation; plants' labels assume typical weather anyway |
| Single-point sampling | A bed isn't a point | Multi-spot capture + interpolation; encourage corner captures for big beds |
| Reflected light, dappled shade | Under-counted | Out of scope for v1; note in UI ("estimates are for direct sun") |

Positioning matters: market it as **"approximate sun mapping — accurate enough to
pick the right plant for the right place"**, not a scientific instrument.

---

## 7. Build Roadmap

### Phase 0 — Prototype (1–2 weeks of effort)
- Solar position engine + unit tests against NOAA reference values.
- Web page: enter lat/lon, upload a panorama, hand-trace the skyline, get
  monthly sun-hours. Proves the whole pipeline with zero sensor work.

### Phase 1 — MVP app (the Spot Check)
- Expo app: GPS, guided panorama capture with sensor tagging, heuristic sky
  segmentation + touch-up, sun-hours report with monthly breakdown and sun
  arcs drawn over the panorama.
- One-tap sun calibration; deciduous tagging.
- **Ship it.** This alone is more useful to a gardener than anything on the market.

### Phase 2 — The Garden Map
- Multi-spot capture, heatmap interpolation, satellite/sketch base map,
  month slider.
- Top-down shadow simulator.
- Plant matcher v1 (curated database, spot → plant suggestions).

### Phase 3 — Gardening companion
- Bed planner, planting calendar + reminders, journal, watering/task engine.
- AR live sun path.
- Verify mode (time-lapse), sharing, PDF pro export.

### Suggested monetization (later)
Free: unlimited spot checks. Paid ("Pro"): full-year heatmaps, planner/calendar,
PDF export, cloud sync. Gardeners demonstrably pay for planning tools.

---

## 8. Competitive Landscape (why this wins)

- **Sun Seeker / Sun Surveyor** (~$10): great AR sun paths, but no shade capture,
  no sun-hours math, zero gardening features. Aimed at photographers.
- **Solmetric SunEye / Solar Pathfinder**: professional solar-site tools,
  $300–$2,500 hardware. We replicate the method on a phone.
- **Gardening planners (Planter, GrowVeg, etc.)**: plant databases and calendars,
  but they *ask you* how much sun a bed gets — the number most beginners don't
  know. We *measure* it and then feed their strength (planning) with our data.

Nobody connects **measured sun → plant decisions**. That connection is the product.

---

## 9. Biggest Risks

1. **Capture UX**: if the panorama sweep is fiddly, users bounce. Invest heavily
   in the guided-capture flow (progress arc, haptic feedback, redo-a-slice).
   Prototype this with real users early.
2. **Compass trust**: one-tap sun calibration is the safety net — prioritize it.
3. **Scope creep**: Tiers 2–3 are big. The MVP is deliberately just the Spot
   Check; everything else stacks on the same skyline data model.
