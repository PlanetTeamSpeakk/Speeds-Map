/**
 * Loader for the binary tile pyramid written by data/etl/build.py.
 *
 * Layout (little-endian, every field 4-byte aligned):
 *   u32 magic 'SPD1' | u32 zoom | u32 count | u32 reserved
 *   u32   idx[count]   web-mercator tile index, y * 2^zoom + x, ascending
 *   f32   dl[count]    Mbps
 *   f32   ul[count]    Mbps
 *   f32   lat[count]   ms
 *   u32   tests[count]
 *
 * Because idx is row-major and sorted, a viewport query is a handful of binary
 * searches (one per tile row) rather than a scan of the whole level -- which is
 * what makes the 99k-cell z11 block usable while panning.
 *
 * One block per (type, quarter, zoom). Unlike the region layers, measurement
 * tiles genuinely differ every quarter, so there is nothing to share here.
 */

const MAGIC = 0x53504431;

/** Which pyramid level to draw at a given map zoom, targeting ~32px cells.
    The levels must match GRID_ZOOMS in data/etl/build.py. */
export function levelForZoom(zoom) {
  if (zoom < 1) return 3;
  if (zoom < 3) return 5;
  if (zoom < 5) return 7;
  if (zoom < 7) return 9;
  return 11;
}

export function tileToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

export function tileToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat, z) {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export class GridLevel {
  constructor(buffer) {
    const head = new Uint32Array(buffer, 0, 4);
    if (head[0] !== MAGIC) throw new Error('not a SPD1 grid block');
    this.zoom = head[1];
    this.count = head[2];
    this.n = 2 ** this.zoom;

    const n = this.count;
    let o = 16;
    this.idx = new Uint32Array(buffer, o, n); o += n * 4;
    this.dl = new Float32Array(buffer, o, n); o += n * 4;
    this.ul = new Float32Array(buffer, o, n); o += n * 4;
    this.lat = new Float32Array(buffer, o, n); o += n * 4;
    this.tests = new Uint32Array(buffer, o, n);
  }

  /** First position with idx >= target. */
  lowerBound(target) {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.idx[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  featureAt(i) {
    const idx = this.idx[i];
    const x = idx % this.n;
    const y = (idx - x) / this.n;
    const w = tileToLon(x, this.zoom);
    const e = tileToLon(x + 1, this.zoom);
    const nlat = tileToLat(y, this.zoom);
    const s = tileToLat(y + 1, this.zoom);
    return {
      type: 'Feature',
      properties: {
        dl: this.dl[i],
        ul: this.ul[i],
        lat: this.lat[i],
        tests: this.tests[i],
        lon: (w + e) / 2,
        clat: (nlat + s) / 2,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[w, s], [e, s], [e, nlat], [w, nlat], [w, s]]],
      },
    };
  }

  /**
   * Cells intersecting a lon/lat box, as GeoJSON.
   * `bounds` is [west, south, east, north]; west may exceed east when the
   * viewport straddles the antimeridian, and either may fall outside +/-180
   * when the map is showing world copies.
   */
  query(bounds, limit = 120000) {
    const [west, south, east, north] = bounds;
    const { n, zoom } = this;

    let y0 = Math.max(0, Math.floor(latToTileY(north, zoom)));
    let y1 = Math.min(n - 1, Math.floor(latToTileY(south, zoom)));

    // Horizontal spans, in tile-x, already unwrapped into [0, n).
    let spans;
    if (east - west >= 360) {
      spans = [[0, n - 1]];
    } else {
      const rawX0 = Math.floor(lonToTileX(west, zoom));
      const rawX1 = Math.floor(lonToTileX(east, zoom));
      const x0 = ((rawX0 % n) + n) % n;
      const x1 = ((rawX1 % n) + n) % n;
      spans = x0 <= x1 ? [[x0, x1]] : [[x0, n - 1], [0, x1]];
    }

    const features = [];
    for (let y = y0; y <= y1 && features.length < limit; y += 1) {
      for (const [xa, xb] of spans) {
        const start = this.lowerBound(y * n + xa);
        const end = y * n + xb;
        for (let i = start; i < this.count && this.idx[i] <= end; i += 1) {
          features.push(this.featureAt(i));
          if (features.length >= limit) break;
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }
}

const cache = new Map();

export async function loadLevel(type, quarter, zoom, base = import.meta.env.BASE_URL) {
  const key = `${type}-${quarter}-z${zoom}`;
  if (!cache.has(key)) {
    const url = `${base}data/grid/${key}.bin`;
    cache.set(
      key,
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${url}: ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => new GridLevel(buf))
        .catch((err) => {
          cache.delete(key);
          throw err;
        }),
    );
  }
  return cache.get(key);
}

/** Warm the blocks playback is about to need, without blocking on them. */
export function prefetchLevel(type, quarters, from, zoom, base, ahead = 2) {
  const i = quarters.indexOf(from);
  if (i < 0) return;
  for (let k = 1; k <= ahead; k += 1) {
    loadLevel(type, quarters[(i + k) % quarters.length], zoom, base).catch(() => {});
  }
}
