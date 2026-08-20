"""
Build web-ready aggregates from the Ookla Open Data speedtest tiles.

Source : s3://ookla-open-data/parquet/performance/  (CC BY-NC-SA 4.0)
Input  : zoom-16 web-mercator tiles, one row per tile per quarter, 2019 Q1 on.
Output : public/data/
           meta.json                    descriptor: quarters, levels, ramp anchors
           countries.geojson            country geometry, ISO3 keyed
           regions/a{L}/{chunk}.json    sub-national geometry, spatially chunked
           regions/a{L}/index.json      which chunks exist
           units/a{L}.json              canonical unit order for the series files
           series/a{L}-{quarter}.bin    per-quarter stats, aligned to that order
           grid/{type}-{quarter}-z{z}.bin   measurement-tile pyramid

The central design point is that **boundaries do not change between quarters**,
so geometry is written once and only the numbers repeat. A quarter of history
costs a ~1.6 MB stats block per level rather than a fresh copy of the map.

Two consequences fall out of that:

  * The cell -> unit spatial join is also quarter-independent. It is cached in
    `cellmap_{L}` and only ever run for tiles never seen before, which turns a
    90-second join into a hash join from the second quarter onwards.
  * Colour anchors are computed once, pooled across every quarter. Per-quarter
    anchors would renormalise each frame and the animation would show almost
    no change -- which is the opposite of the point.

All averages are test-weighted, per Ookla's own aggregation guidance:
    avg = sum(metric * tests) / sum(tests)

Run:  python data/etl/build.py            # everything, resumable
      python data/etl/build.py --quarters 2025Q1,2025Q2
      python data/etl/build.py --keep-parquet
"""

import argparse
import json
import math
import os
import struct
import subprocess
import sys
import time

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RAW = os.path.join(ROOT, "data", "raw")
HIST = os.path.join(RAW, "history")
OUT = os.path.join(ROOT, "public", "data")
GRID_OUT = os.path.join(OUT, "grid")
REGION_OUT = os.path.join(OUT, "regions")
SERIES_OUT = os.path.join(OUT, "series")
UNITS_OUT = os.path.join(OUT, "units")

DB = os.path.join(HIST, "etl.duckdb")
STATE = os.path.join(HIST, "state.json")

BUCKET = "s3://ookla-open-data/parquet/performance"
FIRST_YEAR, FIRST_QUARTER = 2019, 1
LAST_YEAR, LAST_QUARTER = 2026, 2

COUNTRIES_SRC = os.path.join(RAW, "ne_50m_countries.geojson")

# Sub-national levels, from geoBoundaries CGAZ (CC BY 4.0). Both levels use the
# same source so the hierarchy and the ISO3 link are consistent.
#
#   tol        Douglas-Peucker tolerance in degrees. Chosen against the zoom the
#              level is shown at: ~1 km of error is a couple of pixels there.
#   chunkZoom  Web-mercator zoom the level is cut into for delivery. Cutting
#              spatially rather than per country keeps a fetch proportional to
#              the viewport instead of to whichever country you happen to touch.
#              Do not cut finer without clipping geometry to the chunk first:
#              a unit is copied whole into every chunk it touches, and the units
#              that span many chunks are the big convoluted ones, so total size
#              grows far faster than the feature count suggests (z5 -> z6 on
#              ADM2 took 70 MB to 148 MB).
#   minTests   Below this a unit has no published number for that quarter.
ADMIN_LEVELS = {
    1: {
        "src": os.path.join(RAW, "cgaz_ADM1.geojson"),
        "label": "States & provinces",
        "tol": 0.01,
        "chunkZoom": 3,
        "minTests": 100,
    },
    2: {
        "src": os.path.join(RAW, "cgaz_ADM2.geojson"),
        "label": "Districts",
        "tol": 0.01,
        "chunkZoom": 5,
        "minTests": 30,
    },
}

# Map zoom at which each level takes over. Mirrored in src/lib/regions.js.
LEVEL_MIN_ZOOM = {0: 0, 1: 4.5, 2: 6.5}

GRID_ZOOMS = [3, 5, 7, 9, 11]
JOIN_ZOOM = 14

GRID_MAGIC = 0x53504431  # 'SPD1'
SERIES_MAGIC = 0x53505331  # 'SPS1'

MIN_TESTS_PER_TILE = 2
MIN_TESTS_PER_CELL = 15
MIN_TESTS_PER_COUNTRY = 200

TYPES = ("fixed", "mobile")


def log(msg):
    print("[" + time.strftime("%H:%M:%S") + "] " + msg, flush=True)


def sqlpath(p):
    return p.replace(os.sep, "/")


def quarters():
    out = []
    y, q = FIRST_YEAR, FIRST_QUARTER
    while (y, q) <= (LAST_YEAR, LAST_QUARTER):
        out.append((y, q))
        q += 1
        if q == 5:
            y, q = y + 1, 1
    return out


def qid(y, q):
    return f"{y}Q{q}"


def parquet_path(kind, y, q):
    return os.path.join(HIST, f"{kind}_{y}q{q}.parquet")


def s3_uri(kind, y, q):
    month = f"{q * 3 - 2:02d}"
    return (
        f"{BUCKET}/type={kind}/year={y}/quarter={q}/"
        f"{y}-{month}-01_performance_{kind}_tiles.parquet"
    )


def download(kind, y, q):
    dest = parquet_path(kind, y, q)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    log(f"  fetching {kind} {qid(y, q)}")
    subprocess.run(
        ["aws", "s3", "cp", "--no-sign-request", s3_uri(kind, y, q), dest,
         "--only-show-errors"],
        check=True,
    )
    return dest


def load_state():
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    return {"done": {}, "sample": {}}


def save_state(state):
    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump(state, fh)


# --------------------------------------------------------------------- setup


def connect():
    con = duckdb.connect(DB)
    con.sql("INSTALL spatial; LOAD spatial;")
    con.sql("SET preserve_insertion_order = false;")
    con.sql("SET enable_progress_bar = false;")
    return con


def quadkey_xy_sql(zoom, col="quadkey"):
    """Tile x/y at `zoom`, decoded from the leading digits of the z16 quadkey.

    Decoded rather than derived from the tile_x/tile_y centroid columns because
    those only appear from 2023 onwards -- the 2019-2022 files carry just
    quadkey, tile (WKT) and the metrics. The quadkey is in every quarter, and
    decoding it is exact rather than a trig round-trip.
    """
    xs, ys = [], []
    for i in range(zoom):
        bit = 1 << (zoom - 1 - i)
        d = f"substr({col},{i + 1},1)"
        xs.append(f"CASE WHEN {d} IN ('1','3') THEN {bit} ELSE 0 END")
        ys.append(f"CASE WHEN {d} IN ('2','3') THEN {bit} ELSE 0 END")
    return "(" + "+".join(xs) + ") AS tx, (" + "+".join(ys) + ") AS ty"


def tile_centre_sql(zoom):
    """Lon/lat of a tile's centre, as SQL over grouped tx/ty columns.

    The centre, not the mean of the readings inside it: the cell -> unit join is
    cached across quarters, so the point a cell resolves to has to be a property
    of the grid rather than of whichever quarter happened to touch it first.
    """
    n = float(1 << zoom)
    zz = f"(pi() * (1.0 - 2.0 * (ty + 0.5) / {n!r}))"
    return (
        f"((tx + 0.5) / {n!r} * 360.0 - 180.0) AS lon, "
        f"degrees(atan((exp({zz}) - exp(-{zz})) / 2.0)) AS lat"
    )


def prepare_boundaries(con):
    """Load the three boundary sets once into the persistent database."""
    have = {r[0] for r in con.sql("SHOW TABLES").fetchall()}

    if "unit0" not in have:
        log("boundaries: countries")
        con.sql("""
            CREATE TABLE unit0 AS
            SELECT CASE WHEN ISO_A3_EH IS NULL OR ISO_A3_EH IN ('-99', '')
                        THEN ADM0_A3 ELSE ISO_A3_EH END AS id,
                   NAME AS name, CONTINENT AS sub, geom
            FROM ST_Read('""" + sqlpath(COUNTRIES_SRC) + """')
            WHERE NAME <> 'Antarctica'
        """)

    for level, cfg in ADMIN_LEVELS.items():
        if f"unit{level}" in have:
            continue
        if not os.path.exists(cfg["src"]):
            sys.exit("missing input: " + cfg["src"] + "\nRun data/etl/fetch.sh first.")
        log(f"boundaries: admin{level}")
        con.sql(f"""
            CREATE TABLE unit{level} AS
            SELECT shapeID AS id, shapeName AS name, shapeGroup AS sub, geom
            FROM ST_Read('{sqlpath(cfg["src"])}')
        """)

    if "cellseen" not in have:
        con.sql("CREATE TABLE cellseen (tx INTEGER, ty INTEGER)")
    for level in (0, 1, 2):
        if f"cellmap{level}" not in have:
            con.sql(f"CREATE TABLE cellmap{level} (tx INTEGER, ty INTEGER, uid VARCHAR)")

    for level in (0, 1, 2):
        n = con.sql(f"SELECT count(*) FROM unit{level}").fetchone()[0]
        log(f"  level {level}: {n:,} units")


def unit_ids(con, level):
    """Canonical order for the series files: every source unit, sorted by id.

    Ordering on the full source list rather than on units-with-data keeps the
    alignment stable no matter which quarters get rebuilt, which is what makes
    the run resumable.
    """
    return [r[0] for r in con.sql(
        f"SELECT id FROM unit{level} GROUP BY id ORDER BY id"
    ).fetchall()]


# ----------------------------------------------------------------- per quarter


def build_base(con, kind, path):
    con.sql(f"""
        CREATE OR REPLACE TABLE base_{kind} AS
        SELECT tx, ty,
               {tile_centre_sql(JOIN_ZOOM)},
               sum(avg_d_kbps * tests) AS d_sum,
               sum(avg_u_kbps * tests) AS u_sum,
               sum(avg_lat_ms * tests) AS l_sum,
               sum(tests) AS tests, sum(devices) AS devices
        FROM (
            SELECT {quadkey_xy_sql(JOIN_ZOOM)},
                   avg_d_kbps, avg_u_kbps, avg_lat_ms, tests, devices
            FROM read_parquet('{sqlpath(path)}')
            WHERE tests >= {MIN_TESTS_PER_TILE}
              AND avg_d_kbps > 0 AND avg_u_kbps > 0 AND avg_lat_ms > 0
        )
        GROUP BY tx, ty
    """)
    return con.sql(f"SELECT count(*), sum(tests) FROM base_{kind}").fetchone()


def extend_cellmap(con):
    """Spatially join only the tiles never seen in an earlier quarter."""
    con.sql("""
        CREATE OR REPLACE TABLE newcells AS
        SELECT c.tx, c.ty, any_value(c.lon) AS lon, any_value(c.lat) AS lat
        FROM (SELECT tx, ty, lon, lat FROM base_fixed
              UNION ALL
              SELECT tx, ty, lon, lat FROM base_mobile) c
        LEFT JOIN cellseen s ON s.tx = c.tx AND s.ty = c.ty
        WHERE s.tx IS NULL
        GROUP BY c.tx, c.ty
    """)
    n = con.sql("SELECT count(*) FROM newcells").fetchone()[0]
    if not n:
        return 0
    t0 = time.time()
    for level in (0, 1, 2):
        con.sql(f"""
            INSERT INTO cellmap{level}
            SELECT c.tx, c.ty, u.id
            FROM newcells c
            JOIN unit{level} u ON ST_Contains(u.geom, ST_Point(c.lon, c.lat))
        """)
    con.sql("INSERT INTO cellseen SELECT tx, ty FROM newcells")
    log(f"  cellmap: +{n:,} new tiles joined in {time.time() - t0:.0f}s")
    return n


def write_grid(con, kind, q, zoom):
    shift = JOIN_ZOOM - zoom
    rows = con.sql(f"""
        -- tx/ty are already at `zoom` here: the subquery did the shifting.
        SELECT ty * {1 << zoom} + tx AS idx,
               d_sum / tests / 1000.0 AS dl,
               u_sum / tests / 1000.0 AS ul,
               l_sum / tests AS lat, tests
        FROM (
            SELECT tx >> {shift} AS tx, ty >> {shift} AS ty,
                   sum(d_sum) AS d_sum, sum(u_sum) AS u_sum,
                   sum(l_sum) AS l_sum, sum(tests) AS tests
            FROM base_{kind}
            GROUP BY 1, 2
            HAVING sum(tests) >= {MIN_TESTS_PER_CELL}
        )
        ORDER BY idx
    """).fetchall()

    n = len(rows)
    buf = bytearray(struct.pack("<IIII", GRID_MAGIC, zoom, n, 0))
    buf += struct.pack(f"<{n}I", *[r[0] for r in rows])
    buf += struct.pack(f"<{n}f", *[r[1] for r in rows])
    buf += struct.pack(f"<{n}f", *[r[2] for r in rows])
    buf += struct.pack(f"<{n}f", *[r[3] for r in rows])
    buf += struct.pack(f"<{n}I", *[min(int(r[4]), 0xFFFFFFFF) for r in rows])

    with open(os.path.join(GRID_OUT, f"{kind}-{q}-z{zoom}.bin"), "wb") as fh:
        fh.write(buf)
    return n


def level_stats(con, level, kind, min_tests):
    """Test-weighted stats per unit for the quarter currently in base_{kind}."""
    return {
        r[0]: (r[1], r[2], r[3], int(r[4]))
        for r in con.sql(f"""
            SELECT m.uid,
                   sum(b.d_sum) / sum(b.tests) / 1000.0,
                   sum(b.u_sum) / sum(b.tests) / 1000.0,
                   sum(b.l_sum) / sum(b.tests),
                   sum(b.tests)
            FROM base_{kind} b
            JOIN cellmap{level} m ON m.tx = b.tx AND m.ty = b.ty
            GROUP BY m.uid
            HAVING sum(b.tests) >= {min_tests}
        """).fetchall()
    }


def write_series(level, q, ids, per_type):
    """One quarter of stats for one level, aligned to the canonical id order.

    Missing readings are NaN with a zero test count; the client treats a zero
    test count as "not published" rather than as a measurement of zero.
    """
    n = len(ids)
    buf = bytearray(struct.pack("<IIII", SERIES_MAGIC, level, n, 0))
    for kind in TYPES:
        stats = per_type[kind]
        cols = [[], [], [], []]
        for uid in ids:
            row = stats.get(uid)
            if row is None:
                cols[0].append(math.nan)
                cols[1].append(math.nan)
                cols[2].append(math.nan)
                cols[3].append(0)
            else:
                cols[0].append(row[0])
                cols[1].append(row[1])
                cols[2].append(row[2])
                cols[3].append(min(row[3], 0xFFFFFFFF))
        buf += struct.pack(f"<{n}f", *cols[0])
        buf += struct.pack(f"<{n}f", *cols[1])
        buf += struct.pack(f"<{n}f", *cols[2])
        buf += struct.pack(f"<{n}I", *cols[3])

    path = os.path.join(SERIES_OUT, f"a{level}-{q}.bin")
    with open(path, "wb") as fh:
        fh.write(buf)
    return os.path.getsize(path)


def colour_sample(con, kind):
    """z7 cell values for this quarter, for the pooled colour anchors."""
    return con.sql(f"""
        SELECT sum(d_sum) / sum(tests) / 1000.0,
               sum(u_sum) / sum(tests) / 1000.0,
               sum(l_sum) / sum(tests),
               sum(tests)
        FROM base_{kind}
        GROUP BY tx >> {JOIN_ZOOM - 7}, ty >> {JOIN_ZOOM - 7}
        HAVING sum(tests) >= {MIN_TESTS_PER_CELL}
    """).fetchall()


def process_quarter(con, y, q, ids_by_level, keep_parquet):
    quarter = qid(y, q)
    log(f"{quarter}")
    totals = {}
    sample = {k: {"dl": [], "ul": [], "lat": [], "w": []} for k in TYPES}

    for kind in TYPES:
        path = download(kind, y, q)
        cells, tests = build_base(con, kind, path)
        totals[kind] = {"cells": int(cells), "tests": int(tests)}
        log(f"  {kind}: {cells:,} z{JOIN_ZOOM} cells, {tests:,} tests")

    extend_cellmap(con)

    for kind in TYPES:
        for zoom in GRID_ZOOMS:
            write_grid(con, kind, quarter, zoom)
        for row in colour_sample(con, kind):
            sample[kind]["dl"].append(row[0])
            sample[kind]["ul"].append(row[1])
            sample[kind]["lat"].append(row[2])
            sample[kind]["w"].append(row[3])

    for level in (0, 1, 2):
        floor = (MIN_TESTS_PER_COUNTRY if level == 0
                 else ADMIN_LEVELS[level]["minTests"])
        per_type = {k: level_stats(con, level, k, floor) for k in TYPES}
        write_series(level, quarter, ids_by_level[level], per_type)
        totals[f"units{level}"] = len(set(per_type["fixed"]) | set(per_type["mobile"]))

    if not keep_parquet:
        for kind in TYPES:
            try:
                os.remove(parquet_path(kind, y, q))
            except OSError:
                pass

    return totals, sample


# ------------------------------------------------------------------- geometry


def tile_x_of(lon, z):
    return max(0, min((1 << z) - 1, int(math.floor((lon + 180.0) / 360.0 * (1 << z)))))


def tile_y_of(lat, z):
    r = math.radians(max(-85.05112878, min(85.05112878, lat)))
    y = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0
    return max(0, min((1 << z) - 1, int(math.floor(y * (1 << z)))))


def round_ring(pts, nd):
    out = []
    for p in pts:
        v = [round(p[0], nd), round(p[1], nd)]
        if not out or v != out[-1]:
            out.append(v)
    if len(out) < 4:
        return None
    if out[0] != out[-1]:
        out.append(out[0])
    return out


def round_and_bbox(geom, nd=4):
    """Round coordinates onto a shared grid and return (geometry, bbox).

    Rounding rather than re-simplifying is deliberate: neighbouring units share
    vertices, and identical inputs round to identical outputs, so shared borders
    stay exactly coincident instead of drifting apart.
    """
    west = south = math.inf
    east = north = -math.inf

    def ring(pts):
        nonlocal west, south, east, north
        r = round_ring(pts, nd)
        if r is None:
            return None
        for x, yy in r:
            west = min(west, x)
            east = max(east, x)
            south = min(south, yy)
            north = max(north, yy)
        return r

    if geom["type"] == "Polygon":
        rings = [r for r in (ring(x) for x in geom["coordinates"]) if r]
        out = {"type": "Polygon", "coordinates": rings} if rings else None
    else:
        polys = []
        for poly in geom["coordinates"]:
            rings = [r for r in (ring(x) for x in poly) if r]
            if rings:
                polys.append(rings)
        out = {"type": "MultiPolygon", "coordinates": polys} if polys else None

    if out is None:
        return None, None
    return out, (west, south, east, north)


def units_with_data(level, ids, all_quarters):
    """Ids that have a published reading in at least one quarter.

    Read back from the series files rather than tracked in memory, so a partial
    or resumed run still produces geometry consistent with the series on disk.
    """
    n = len(ids)
    seen = set()
    for q in all_quarters:
        path = os.path.join(SERIES_OUT, f"a{level}-{q}.bin")
        if not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            blob = fh.read()
        for kind_i in range(len(TYPES)):
            # tests is the 4th of four arrays per type
            off = 16 + kind_i * n * 16 + n * 12
            tests = struct.unpack_from(f"<{n}I", blob, off)
            for i, t in enumerate(tests):
                if t:
                    seen.add(ids[i])
    return seen


def write_countries_geojson(con, keep):
    rows = con.sql("""
        SELECT id, any_value(name), any_value(sub),
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(any_value(geom), 0.01))
        FROM unit0 GROUP BY id
    """).fetchall()
    feats = []
    for uid, name, sub, gj in rows:
        if uid not in keep:
            continue
        geom, _ = round_and_bbox(json.loads(str(gj)), nd=2)
        if geom is None:
            continue
        feats.append({
            "type": "Feature", "id": uid,
            "properties": {"id": uid, "name": name, "sub": sub},
            "geometry": geom,
        })
    path = os.path.join(OUT, "countries.geojson")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh,
                  separators=(",", ":"))
    log(f"countries.geojson: {len(feats)} features, "
        f"{os.path.getsize(path) / 1e6:.1f} MB")
    return len(feats)


def write_region_geometry(con, level, cfg, keep):
    rows = con.sql(f"""
        SELECT id, any_value(name), any_value(sub),
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(any_value(geom),
                                                        {cfg["tol"]!r}))
        FROM unit{level} GROUP BY id
    """).fetchall()

    z = cfg["chunkZoom"]
    chunks = {}
    emitted = 0
    for uid, name, sub, gj in rows:
        if uid not in keep:
            continue
        geom, bbox = round_and_bbox(json.loads(str(gj)))
        if geom is None:
            continue
        feature = {
            "type": "Feature", "id": uid,
            "properties": {"id": uid, "name": name or "", "sub": sub},
            "geometry": geom,
        }
        emitted += 1
        x0, x1 = tile_x_of(bbox[0], z), tile_x_of(bbox[2], z)
        y0, y1 = tile_y_of(bbox[3], z), tile_y_of(bbox[1], z)
        for ty in range(y0, y1 + 1):
            for tx in range(x0, x1 + 1):
                chunks.setdefault(ty * (1 << z) + tx, []).append(feature)

    out_dir = os.path.join(REGION_OUT, f"a{level}")
    os.makedirs(out_dir, exist_ok=True)
    for stale in os.listdir(out_dir):
        os.remove(os.path.join(out_dir, stale))

    total = 0
    for idx, feats in chunks.items():
        path = os.path.join(out_dir, f"{idx}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": feats}, fh,
                      separators=(",", ":"))
        total += os.path.getsize(path)
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"level": level, "chunkZoom": z, "chunks": sorted(chunks)}, fh,
                  separators=(",", ":"))

    log(f"admin{level} geometry: {emitted:,} units -> {len(chunks):,} chunks, "
        f"{total / 1e6:.1f} MB")
    return emitted, len(chunks), total


# --------------------------------------------------------------------- colour


def ramp_stops(values, weights, n=7, lo=0.02, hi=0.995):
    """Anchor values for the colour ramp: `n` test-weighted quantiles spread
    evenly between the `lo` and `hi` percentiles, one per ramp colour.

    Pooled over every quarter, deliberately. Anchors recomputed per quarter
    would renormalise each frame, and an animation of a decade of speed growth
    would show almost nothing moving.

    `hi` sits at p99.5 rather than p98 because pooling across seven years of
    growth pushes the top of the scale down: at p98 the whole visible top ten
    of the newest quarter clamped to one colour. p99.5 cuts that to four while
    leaving the rest of the ramp essentially unchanged.
    """
    pairs = sorted(zip(values, weights))
    if not pairs:
        # Ascending even when empty: `interpolate` rejects repeated stops.
        return [round(i * 0.01, 2) for i in range(n)]
    total = float(sum(weights))
    targets = [(lo + (hi - lo) * i / (n - 1)) * total for i in range(n)]

    out, acc, k = [], 0.0, 0
    for v, w in pairs:
        acc += w
        while k < n and acc >= targets[k]:
            out.append(round(v, 2))
            k += 1
    while len(out) < n:
        out.append(round(pairs[-1][0], 2))
    for i in range(1, n):
        if out[i] <= out[i - 1]:
            out[i] = round(out[i - 1] + 0.01, 2)
    return out


# ----------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quarters", help="comma-separated, e.g. 2025Q1,2025Q2")
    ap.add_argument("--keep-parquet", action="store_true",
                    help="do not delete each quarter's parquet after processing")
    ap.add_argument("--force", action="store_true", help="reprocess done quarters")
    args = ap.parse_args()

    for d in (HIST, GRID_OUT, REGION_OUT, SERIES_OUT, UNITS_OUT):
        os.makedirs(d, exist_ok=True)

    all_q = quarters()
    wanted = all_q
    if args.quarters:
        pick = {s.strip().upper() for s in args.quarters.split(",")}
        wanted = [(y, q) for (y, q) in all_q if qid(y, q) in pick]

    con = connect()
    prepare_boundaries(con)

    ids_by_level = {lv: unit_ids(con, lv) for lv in (0, 1, 2)}
    for lv, ids in ids_by_level.items():
        with open(os.path.join(UNITS_OUT, f"a{lv}.json"), "w", encoding="utf-8") as fh:
            json.dump({"level": lv, "ids": ids}, fh, separators=(",", ":"))

    state = load_state()
    pooled = {k: {"dl": [], "ul": [], "lat": [], "w": []} for k in TYPES}

    for y, q in wanted:
        quarter = qid(y, q)
        if quarter in state["done"] and not args.force:
            log(f"{quarter}: already built, skipping")
            continue
        totals, sample = process_quarter(con, y, q, ids_by_level, args.keep_parquet)
        state["done"][quarter] = totals
        state["sample"][quarter] = {
            k: {m: sample[k][m] for m in ("dl", "ul", "lat", "w")} for k in TYPES
        }
        save_state(state)

    for quarter, s in state["sample"].items():
        for kind in TYPES:
            for m in ("dl", "ul", "lat", "w"):
                pooled[kind][m].extend(s[kind][m])

    built = [q for (y, q) in ((y, qid(y, q)) for y, q in all_q) if q in state["done"]]
    log(f"quarters built: {len(built)}")

    keep0 = units_with_data(0, ids_by_level[0], built)
    n_countries = write_countries_geojson(con, keep0)
    levels = [{
        "level": 0, "label": "Countries", "units": n_countries,
        "minZoom": LEVEL_MIN_ZOOM[0], "minTests": MIN_TESTS_PER_COUNTRY,
    }]
    for level, cfg in sorted(ADMIN_LEVELS.items()):
        keep = units_with_data(level, ids_by_level[level], built)
        units, nchunks, nbytes = write_region_geometry(con, level, cfg, keep)
        levels.append({
            "level": level, "label": cfg["label"], "units": units,
            "chunkZoom": cfg["chunkZoom"], "chunks": nchunks, "bytes": nbytes,
            "minTests": cfg["minTests"], "minZoom": LEVEL_MIN_ZOOM[level],
        })

    types_meta = {}
    for kind in TYPES:
        w = pooled[kind]["w"]
        types_meta[kind] = {
            "tests": sum(state["done"][q][kind]["tests"] for q in built),
            "stops": {
                "dl": ramp_stops(pooled[kind]["dl"], w),
                "ul": ramp_stops(pooled[kind]["ul"], w),
                "lat": ramp_stops(pooled[kind]["lat"], w),
            },
        }

    meta = {
        "source": {
            "name": "Speedtest by Ookla Global Fixed and Mobile Network Performance Maps",
            "url": "https://registry.opendata.aws/speedtest-global-performance/",
            "bucket": BUCKET,
            "license": "CC BY-NC-SA 4.0",
        },
        "boundaries": {
            "name": "Natural Earth 1:50m Admin 0 Countries",
            "url": "https://www.naturalearthdata.com/",
            "license": "Public domain",
        },
        "subnational": {
            "name": "geoBoundaries CGAZ (ADM1, ADM2)",
            "url": "https://www.geoboundaries.org/",
            "license": "CC BY 4.0",
        },
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "joinZoom": JOIN_ZOOM,
        "gridZooms": GRID_ZOOMS,
        "minTests": {"tile": MIN_TESTS_PER_TILE, "cell": MIN_TESTS_PER_CELL,
                     "country": MIN_TESTS_PER_COUNTRY},
        "quarters": [
            {
                "id": q,
                "label": f"Q{q[-1]} {q[:4]}",
                "year": int(q[:4]),
                "quarter": int(q[-1]),
                "tests": {k: state["done"][q][k]["tests"] for k in TYPES},
            }
            for q in built
        ],
        "levels": levels,
        "types": types_meta,
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    log("wrote meta.json")
    log("done")


if __name__ == "__main__":
    main()
