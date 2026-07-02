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
