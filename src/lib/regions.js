/**
 * Administrative region layer: countries at world zoom, states/provinces
 * further in, districts further in still.
 *
 * Level 0 (countries) is a single file that is always resident. Levels 1 and 2
 * are cut into web-mercator chunks by the ETL and fetched as the viewport needs
 * them -- cutting spatially rather than per country keeps a fetch proportional
 * to what is on screen instead of to whichever country the cursor is over.
 */

import { lonToTileX, latToTileY } from './grid.js';

function bboxOf(geometry) {
  const polys =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polys) {
    for (const [lon, lat] of poly[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}

/** Does a cached unit extent overlap a lon/lat viewport box? */
export function overlaps(bbox, bounds) {
  if (!bbox) return true;
  return (
    bbox[0] <= bounds[2] &&
    bbox[2] >= bounds[0] &&
    bbox[1] <= bounds[3] &&
    bbox[3] >= bounds[1]
  );
}

/** Never pull more than this many chunks for one viewport. A wide desktop at
    the bottom of a level's zoom band covers about ten; the headroom is for
    ultrawide windows, and the cap is what stops a zoomed-out pan from asking
    for a continent. */
const MAX_CHUNKS = 24;

export class RegionStore {
  constructor(meta, base) {
    this.base = base;
    // Coarse to fine, each with the map zoom at which it takes over.
    this.levels = [...meta.levels].sort((a, b) => a.level - b.level);
    this.indexes = new Map(); // level -> Promise<Set<chunk idx>>
    this.chunks = new Map(); // "level/idx" -> Promise<Feature[]>
  }

  levelForZoom(zoom) {
    let pick = this.levels[0];
    for (const l of this.levels) if (zoom >= l.minZoom) pick = l;
    return pick;
  }

  levelInfo(level) {
    return this.levels.find((l) => l.level === level);
  }

  loadIndex(level) {
    if (!this.indexes.has(level)) {
      this.indexes.set(
        level,
        fetch(`${this.base}data/regions/a${level}/index.json`)
          .then((r) => {
            if (!r.ok) throw new Error(`region index a${level}: ${r.status}`);
            return r.json();
          })
          .then((j) => new Set(j.chunks))
          .catch((err) => {
            this.indexes.delete(level);
            throw err;
          }),
      );
    }
    return this.indexes.get(level);
  }

  loadChunk(level, idx) {
    const key = `${level}/${idx}`;
    if (!this.chunks.has(key)) {
      this.chunks.set(
        key,
        fetch(`${this.base}data/regions/a${level}/${idx}.json`)
          .then((r) => {
            if (!r.ok) throw new Error(`region chunk ${key}: ${r.status}`);
            return r.json();
          })
          .then((j) => {
            // Cache each unit's extent once, on first load. Chunks are much
            // larger than a viewport, so callers need a cheap way to ask which
            // of the loaded units are actually on screen.
            for (const f of j.features) f._bbox = bboxOf(f.geometry);
            return j.features;
          })
          .catch((err) => {
            this.chunks.delete(key);
            throw err;
          }),
      );
    }
    return this.chunks.get(key);
  }

  /** Chunk indices covering `bounds`, nearest the centre first. */
  chunksFor(level, bounds) {
    const z = this.levelInfo(level).chunkZoom;
    const n = 2 ** z;
    const [west, south, east, north] = bounds;

    const y0 = Math.max(0, Math.floor(latToTileY(north, z)));
    const y1 = Math.min(n - 1, Math.floor(latToTileY(south, z)));

    let xs;
    if (east - west >= 360) {
      xs = Array.from({ length: n }, (_, i) => i);
    } else {
      const x0 = Math.floor(lonToTileX(west, z));
      const x1 = Math.floor(lonToTileX(east, z));
      xs = [];
      for (let x = x0; x <= x1; x += 1) xs.push(((x % n) + n) % n);
    }

    const cx = (lonToTileX((west + east) / 2, z) % n + n) % n;
    const cy = latToTileY((south + north) / 2, z);

    const out = [];
    for (let y = y0; y <= y1; y += 1) {
      for (const x of xs) {
        out.push({ idx: y * n + x, d: (x - cx) ** 2 + (y - cy) ** 2 });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((c) => c.idx);
  }

  /**
   * Features of `level` covering `bounds`, de-duplicated by id (a unit is
   * written into every chunk its bbox touches, so overlaps are expected).
   */
  async featuresFor(level, bounds) {
    const present = await this.loadIndex(level);
    const wanted = this.chunksFor(level, bounds)
      .filter((i) => present.has(i))
      .slice(0, MAX_CHUNKS);
    const lists = await Promise.all(
      wanted.map((i) => this.loadChunk(level, i).catch(() => [])),
    );

    const seen = new Set();
    const features = [];
    for (const list of lists) {
      for (const f of list) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        features.push(f);
      }
    }
    return { type: 'FeatureCollection', features };
  }
}
