# World Internet Speeds

An interactive world map of average internet speeds, built from the
[Speedtest by Ookla Global Performance dataset](https://registry.opendata.aws/speedtest-global-performance/)
on the AWS Open Data registry.

A timeline runs across the bottom: scrub any quarter from 2019 Q1 to 2026 Q2,
or press play to animate through all 30. The world average climbs from
**59.9 Mbps to 239.7 Mbps** over that span, and a sparkline behind the slider
traces it. Two ways to read the same data:

- **Regions** — a choropleth that subdivides as you zoom: countries at world
  view, states and provinces from zoom 3.5, districts from zoom 6.5. Every
  level is clickable, and the ranking beside the map follows whatever level
  you are on.
- **Detail grid** — the underlying web-mercator measurement tiles, sharpening
  from continent-sized blocks down to ~5 km cells as you zoom in.

Both views switch between fixed broadband and mobile, and between download,
upload and latency. The colour scale is fixed across every level **and every
quarter**, so a place does not change colour because you zoomed in on it, and a
colour change over time is a real change rather than a rescaled axis.

## Running it

```bash
npm install
npm run dev
```

The prepared data is committed under `public/data/`, so the app runs without
touching S3. No API keys or accounts are needed for anything — the Ookla bucket
is public, and the basemap is keyless CARTO/OpenStreetMap raster tiles.

```bash
npm run build
```

## Rebuilding the data

Only needed to pick up a newly published quarter, or to change how the
aggregates are cut.

```bash
bash data/etl/fetch.sh
python data/etl/build.py
```

`fetch.sh` pulls the boundary files. `build.py` does everything else: it
downloads each quarter's parquet from the public bucket itself, processes it,
and deletes it again, so peak disk is about 600 MB rather than the 15 GB the
full archive would take.

The run is **resumable** — progress is recorded in `data/raw/history/state.json`
and finished quarters are skipped, so an interrupted run picks up where it left
off. A full build from nothing is roughly an hour, most of it the one-off
cell-to-unit spatial join in the first quarter.

```bash
python data/etl/build.py --quarters 2026Q2      # just one quarter
python data/etl/build.py --force                # rebuild everything
python data/etl/build.py --keep-parquet         # keep the raw files
```

When Ookla publishes a new quarter, bump `LAST_YEAR` / `LAST_QUARTER` at the top
of `build.py` and re-run; only the new quarter is processed.

## How the data is processed

The source is one row per **zoom-16 web-mercator tile** (~610 m at the equator)
per quarter — 6.4M fixed rows and 3.4M mobile rows in a recent quarter — each
carrying mean download, upload and latency plus the number of tests behind it.
There are 30 such quarters, 15.1 GB in total.

The design turns on one fact: **boundaries do not change between quarters.**
Geometry is written once and only the numbers repeat, so a quarter of history
costs a ~1.6 MB stats block rather than a fresh copy of the map. Two things
follow:

- The cell-to-unit spatial join is also quarter-independent. It is cached and
  only ever run for tiles never seen before, which turns a 90-second join into
  a hash join from the second quarter onwards.
- Tile coordinates are decoded from the **quadkey**, not from the `tile_x` /
  `tile_y` centroid columns — those only exist from 2023 onwards, while the
  quadkey is in every quarter. (Checked against 400k rows of a quarter carrying
  both: they agree exactly.)

`data/etl/build.py` does the following, all in DuckDB:

1. **Filter.** Drops tiles with a single test, and tiles with a zero reading.
2. **Roll up to zoom 14** (~2.4 km) once. Every later step reads this table.
3. **Weight by tests.** Every average is `sum(metric × tests) / sum(tests)`,
   which is Ookla's own guidance — a tile with 4,000 tests should not count the
   same as one with 3.
4. **Regional stats.** Zoom-14 cell centroids are point-in-polygon joined
   against three sets of boundaries: Natural Earth 1:50m countries, then
   geoBoundaries CGAZ ADM1 and ADM2. Units under a per-level test floor (200
   country, 100 ADM1, 30 ADM2) are dropped rather than shown with a number
   nobody should trust — for ADM2 that removes about a third of the world's
   districts, and their geometry is not shipped either.
5. **Tile pyramid.** Levels 3, 5, 7, 9 and 11 are written as compact binary
   blocks, cells under 15 tests excluded.
6. **Colour anchors.** Seven test-weighted quantiles spanning the 2nd to 98th
   percentile, one per ramp colour, **pooled across every quarter**. Quantile
   spacing makes the ramp spend its range where the measurements actually are
   instead of on a few extreme cells; trimming the tails stops one absurd
   outlier from flattening everything else. Pooling is what makes the animation
   mean anything — per-quarter anchors would renormalise each frame and a
   decade of speed growth would show almost nothing moving.

### Region chunks

Countries are one file. The two sub-national levels are cut into web-mercator
chunks (`public/data/regions/a1/`, `a2/`) and fetched as the viewport needs
them. Cutting spatially rather than per country is what keeps a fetch
proportional to what is on screen: Brazil has 5,570 districts and nobody needs
all of them to look at São Paulo. A unit whose bounding box straddles a chunk
boundary is written into both, and the client de-duplicates by feature id.

Chunks are cut coarsely on purpose. A unit is copied whole into every chunk it
touches, and the units that span many chunks are the big convoluted ones, so
total size grows much faster than the feature count suggests — cutting ADM2 at
zoom 6 instead of 5 took the level from 70 MB to 148 MB. Going finer than this
would mean clipping geometry to the chunk first.

Geometry is Douglas-Peucker simplified at ~1 km and then rounded onto a shared
4-decimal grid. The rounding is what keeps neighbouring borders exactly
coincident: identical input vertices round to identical output vertices.
Simplification alone can leave sub-pixel slivers between neighbours, so region
fills are drawn with a matching outline colour to close them.

### The series format

Statistics live apart from geometry, one flat block per level per quarter, with
rows aligned to a canonical unit order shipped in `units/a{L}.json`. A lookup is
an index into a typed array, so scrubbing the timeline costs no parsing.

```
u32 magic 'SPS1' | u32 level | u32 count | u32 reserved
then for fixed, then mobile:
  f32 dl[count] | f32 ul[count] | f32 lat[count] | u32 tests[count]
```

A unit with no published reading that quarter has NaN metrics and zero tests.
Zero tests means *not published* — never a measurement of zero.

### The binary grid format

Levels are shipped as `public/data/grid/{type}-z{zoom}.bin` rather than GeoJSON —
the z11 fixed block is 99,308 cells, which is 1.9 MB binary against roughly 20 MB
of GeoJSON.

```
u32 magic 'SPD1' | u32 zoom | u32 count | u32 reserved
u32   idx[count]     tile index, y * 2^zoom + x, ascending
f32   dl[count]      Mbps
f32   ul[count]      Mbps
f32   lat[count]     ms
u32   tests[count]
```

Because `idx` is row-major and sorted, the client answers a viewport query with
one binary search per tile row instead of scanning the level, then builds
GeoJSON for just the cells on screen. That is what keeps panning smooth at the
finest level.

## Reading the map

- The colour scale is **continuous** — one hue, light to dark. The seven ramp
  colours are anchors pinned to quantiles of the data; every value in between
  is interpolated, so two places with slightly different speeds get slightly
  different colours rather than being flattened into the same bucket.
- The legend gradient is drawn on a **linear value axis**, so a colour read off
  the map lands at the right number on the bar. The gradient therefore looks
  unevenly spaced — that unevenness is the shape of the distribution. Ends are
  marked ≤ and ≥ because the ramp clamps outside the 2nd and 98th percentile.
- Direction never flips between metrics — so on latency the deep end is the
  *worst* end, which the legend says in words rather than encoding through
  colour.
- The ramp anchors differently per theme, so "more" always means more contrast
  against the surface: the pale end recedes on the light basemap, the deep end
  recedes on the dark one.
- **A selected country stays selected however far you zoom.** Flying to a small
  country lands past the sub-national threshold, so the map switches to
  districts — the country selection survives that, and keeps updating as you
  scrub the timeline, which is the only way to follow one place through the
  years. The summary marks the figure with the level it came from when that is
  not the level on screen. A sub-national selection only lives while its own
  level is drawn, since there is nothing to resolve it against otherwise.
- **The map always shows the finest reading it has.** Zooming past the country
  level does not hide a place that has no sub-national data. A country with no
  published units keeps its own figure at full strength, and a unit that fell
  below the test floor that quarter inherits its country's figure rather than
  becoming a hole. Both cases say so in the tooltip — *"Country total — no
  districts published here"* — so a coarse number is never mistaken for a fine
  one, and neither is ranked in the list beside real district readings.

  This matters most when scrubbing back: 30% of Indian districts were below the
  floor in 2019 Q1, and without the fallback a third of the country would blink
  out as the animation ran.
- **No published data** is a neutral grey that is deliberately not a step on the
  ramp, so a country nobody tested can't be misread as a slow one.
- "View as table" gives the full ranking as text, for when colour isn't the
  right channel.

## Caveats worth knowing

- These are **speeds people measured**, not speeds available for purchase.
  Speedtest runs are self-selected: users tend to test when something feels
  wrong, or right after an upgrade. Read it as a picture of measured experience,
  not of infrastructure.
- Country averages are dominated by wherever the tests came from, which skews
  urban in most countries.
- Region assignment is by tile centroid at ~2.4 km, so cells straddling a
  border land on one side of it. This matters more for districts than for
  countries: a small urban district can pick up a cell from its neighbour.
- Country ids come from Natural Earth and a region's parent code from
  geoBoundaries. They agree everywhere except Kosovo, which Natural Earth has
  no ISO code for; `COUNTRY_ALIAS` in `src/main.js` bridges the two.
- Administrative levels are not comparable across countries. An ADM2 unit is a
  US county, a French arrondissement, and an English district — different
  populations, different areas, different meanings.
- Small territories can swing quarter to quarter on a few hundred tests. The
  200-test floor removes the worst of it, not all of it — expect some flicker
  in sparse places while the animation plays.
- Coverage grows over time. Early quarters have fewer tests and fewer units
  above the floor, so part of what the animation shows is Speedtest's own
  spread, not only networks getting faster. The test count beside the timeline
  is there to keep that visible.

## Attribution and licence

Speed data: **Speedtest® by Ookla® Global Fixed and Mobile Network Performance
Maps**, provided under a
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
licence](https://creativecommons.org/licenses/by-nc-sa/4.0/). Ookla trademarks
are used with no endorsement implied. **The NonCommercial term applies to
anything you build on this** — it is the binding constraint if you plan to
deploy it.

Country boundaries: [Natural Earth](https://www.naturalearthdata.com/) 1:50m
Admin 0 Countries, public domain.

Sub-national boundaries: [geoBoundaries](https://www.geoboundaries.org/) CGAZ
(ADM1, ADM2), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Basemap: © OpenStreetMap contributors, © [CARTO](https://carto.com/attributions).

## Layout

```
data/etl/fetch.sh        pull raw parquet + boundaries (no credentials)
data/etl/build.py        DuckDB aggregation -> public/data/
public/data/             generated, committed
src/lib/palette.js       ramp, metric definitions, formatting
src/lib/grid.js          binary pyramid loader + viewport query
src/lib/regions.js       admin-level picker + on-demand chunk loading
src/lib/series.js        per-quarter statistics, joined to geometry client-side
src/lib/mapstyle.js      keyless raster basemap style
src/main.js              state, layers, interaction
```
