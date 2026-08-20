/**
 * Per-quarter statistics, kept separate from geometry.
 *
 * Boundaries do not move between quarters, so the map itself is downloaded
 * once and only the numbers repeat. Each quarter of one admin level is a flat
 * binary block whose rows line up with a canonical unit order shipped in
 * units/a{L}.json -- so a lookup is an index into a typed array, and switching
 * quarters during playback costs no parsing.
 *
 * Layout (little-endian), for count = number of units in the canonical order:
 *   u32 magic 'SPS1' | u32 level | u32 count | u32 reserved
 *   then, for fixed and then mobile:
 *     f32 dl[count] | f32 ul[count] | f32 lat[count] | u32 tests[count]
 *
 * A unit with no published reading for that quarter has NaN metrics and a zero
 * test count. Zero tests means "not published" -- never a measurement of zero.
 */

const MAGIC = 0x53505331;

class Frame {
  constructor(buffer, index) {
    const head = new Uint32Array(buffer, 0, 4);
    if (head[0] !== MAGIC) throw new Error('not an SPS1 series block');
    this.level = head[1];
    this.count = head[2];
    this.index = index;

    const n = this.count;
    let o = 16;
    const block = () => {
      const dl = new Float32Array(buffer, o, n);
      const ul = new Float32Array(buffer, o + n * 4, n);
      const lat = new Float32Array(buffer, o + n * 8, n);
      const tests = new Uint32Array(buffer, o + n * 12, n);
      o += n * 16;
      return { dl, ul, lat, tests };
    };
    this.fixed = block();
    this.mobile = block();
  }

  /**
   * Test-weighted mean across every unit in the block. Used for the world
   * figure and the trend line, so both come from the same arithmetic and can
   * never disagree.
   */
  worldMean(type) {
    const b = type === 'fixed' ? this.fixed : this.mobile;
    let dl = 0;
    let ul = 0;
    let lat = 0;
    let w = 0;
    for (let i = 0; i < this.count; i += 1) {
      const t = b.tests[i];
      if (!t) continue;
      dl += b.dl[i] * t;
      ul += b.ul[i] * t;
      lat += b.lat[i] * t;
      w += t;
    }
    return w ? { dl: dl / w, ul: ul / w, lat: lat / w, tests: w } : null;
  }

  /** Readings for one unit, or null when nothing was published. */
  get(id, type) {
    const i = this.index.get(id);
    if (i === undefined) return null;
    const b = type === 'fixed' ? this.fixed : this.mobile;
    if (!b.tests[i]) return null;
    return { dl: b.dl[i], ul: b.ul[i], lat: b.lat[i], tests: b.tests[i] };
  }
}

export class SeriesStore {
  constructor(meta, base) {
    this.base = base;
    this.quarters = meta.quarters.map((q) => q.id);
    this.units = new Map(); // level -> Promise<Map<id, row>>
    this.frames = new Map(); // "level/quarter" -> Promise<Frame>
  }

  loadUnits(level) {
    if (!this.units.has(level)) {
      this.units.set(
        level,
        fetch(`${this.base}data/units/a${level}.json`)
          .then((r) => {
            if (!r.ok) throw new Error(`units a${level}: ${r.status}`);
            return r.json();
          })
          .then((j) => new Map(j.ids.map((id, i) => [id, i])))
          .catch((err) => {
            this.units.delete(level);
            throw err;
          }),
      );
    }
    return this.units.get(level);
  }

  loadFrame(level, quarter) {
    const key = `${level}/${quarter}`;
    if (!this.frames.has(key)) {
      this.frames.set(
        key,
        Promise.all([
          this.loadUnits(level),
          fetch(`${this.base}data/series/a${level}-${quarter}.bin`).then((r) => {
            if (!r.ok) throw new Error(`series ${key}: ${r.status}`);
            return r.arrayBuffer();
          }),
        ])
          .then(([index, buf]) => new Frame(buf, index))
          .catch((err) => {
            this.frames.delete(key);
            throw err;
          }),
      );
    }
    return this.frames.get(key);
  }

  /** Warm the frames playback is about to need, without blocking on them. */
  prefetch(level, quarter, ahead = 2) {
    const i = this.quarters.indexOf(quarter);
    if (i < 0) return;
    for (let k = 1; k <= ahead; k += 1) {
      const q = this.quarters[(i + k) % this.quarters.length];
      this.loadFrame(level, q).catch(() => {});
    }
  }
}

/**
 * Copy one quarter's readings onto feature properties, where the map's paint
 * expressions can see them. Properties are overwritten in place because the
 * same cached feature objects are reused for every quarter.
 *
 * `inherit(feature, type)` supplies a coarser reading for units that published
 * nothing this quarter -- in practice the parent country's figure. Without it a
 * unit below the test floor becomes a hole in the map, and there are a lot of
 * them in the early years: 30% of Indian districts in 2019 Q1. Inherited values
 * are flagged `{prefix}_inh` so the tooltip can say the number is coarser than
 * the level being drawn, and so the ranking can leave them out.
 */
export function applyFrame(features, frame, inherit = null) {
  for (const f of features) {
    const id = f.properties.id;
    for (const [type, prefix] of [['fixed', 'f'], ['mobile', 'm']]) {
      let row = frame ? frame.get(id, type) : null;
      let inherited = false;
      if (!row && inherit) {
        row = inherit(f, type);
        inherited = Boolean(row);
      }
      if (row) {
        f.properties[`${prefix}_dl`] = row.dl;
        f.properties[`${prefix}_ul`] = row.ul;
        f.properties[`${prefix}_lat`] = row.lat;
        f.properties[`${prefix}_tests`] = row.tests;
        f.properties[`${prefix}_inh`] = inherited ? 1 : 0;
      } else {
        delete f.properties[`${prefix}_dl`];
        delete f.properties[`${prefix}_ul`];
        delete f.properties[`${prefix}_lat`];
        delete f.properties[`${prefix}_tests`];
        delete f.properties[`${prefix}_inh`];
      }
    }
  }
  return features;
}
