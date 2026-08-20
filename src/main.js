// maplibre-gl 6 ships named exports only; there is no default export.
import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

// maplibre-gl 6 locates its worker by resolving a sibling file against
// `import.meta.url`. Any bundler that moves the library off its own directory
// -- Vite's dep pre-bundling in dev, Rollup chunking in a build -- breaks that
// lookup, and the symptom is silent: raster tiles still draw, but every
// GeoJSON source hangs forever because nothing ever answers `loadData`.
// Handing Vite the worker entry explicitly makes the URL correct in both modes.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);

import {
  METRICS,
  TYPES,
  NO_DATA,
  THEME,
  colorAt,
  gradientCss,
  positionOf,
  rampExpression,
  formatValue,
  formatNumber,
  formatCount,
} from './lib/palette.js';
import { baseStyle, cartoTiles, LABEL_ANCHOR } from './lib/mapstyle.js';
import { loadLevel, levelForZoom, prefetchLevel } from './lib/grid.js';
import { RegionStore, overlaps } from './lib/regions.js';
import { SeriesStore, applyFrame } from './lib/series.js';

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);
const EMPTY = { type: 'FeatureCollection', features: [] };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fill opacity for the layer the pointer is working against. */
const HOVER_OPACITY = [
  'case',
  ['boolean', ['feature-state', 'hover'], false],
  0.95,
  0.78,
];
/** Country fill when it is only a fallback wash beneath the region layers. */
const UNDERLAY_OPACITY = 0.3;

/**
 * Country ids come from Natural Earth; a region's parent code comes from
 * geoBoundaries. They agree everywhere except Kosovo, which Natural Earth has
 * no ISO code for (it falls back to KOS) while geoBoundaries uses XKX. Without
 * this bridge Kosovo reads as both covered and uncovered at once.
 *
 * geoBoundaries also has numeric codes for disputed areas with no Natural Earth
 * counterpart; those simply stay unmatched, which is the right answer.
 */
const COUNTRY_ALIAS = { XKX: 'KOS' };
const countryIdOf = (code) => COUNTRY_ALIAS[code] ?? code;

const state = {
  type: 'fixed',
  metric: 'dl',
  view: 'regions',
  theme: 'dark',
  level: 0, // 0 countries, 1 states/provinces, 2 districts
  quarter: 0, // index into meta.quarters
  playing: false,
  speed: 800,
  selected: null,
  search: '',
};

let meta;
let geo; // country FeatureCollection
let regions; // RegionStore  - geometry, cached across quarters
let series; // SeriesStore  - the numbers, one block per quarter
let regionFeatures = []; // every loaded unit of the active sub-national level
let visibleFeatures = []; // the subset actually on screen -- what the list ranks
/** Countries that have at least one published unit at the active level. A
    country outside this set has no finer data to show, so it keeps its own
    figure instead of being dimmed to an empty wash. */
let covered = new Set();
let fallbackCountries = []; // in view, with data, but no units at this level
const frames = { 0: null, 1: null, 2: null };

/** World average per quarter, for the timeline trend line. The country frames
    are ~8 KB each, so the whole series is a couple of hundred KB. */
let worldTrend = null;

const countryBounds = new Map(); // union extent, for zooming to a country
const countryParts = new Map(); // one extent per polygon part, for hit tests
const countryNames = new Map();
const rowEls = new Map(); // unit id -> ranking row button
let map;
let dataToken = 0;

/* ------------------------------------------------------------------ data */

async function fetchJSON(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/** Longitude/latitude bbox, resolved across the antimeridian. */
function boundsOf(geometry) {
  const polys =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const acc = (shift) => {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const poly of polys) {
      for (const [lon, lat] of poly[0]) {
        const x = shift && lon < 0 ? lon + 360 : lon;
        if (x < w) w = x;
        if (x > e) e = x;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
    return [w, s, e, n];
  };
  const plain = acc(false);
  const shifted = acc(true);
  // Fiji, Russia and the Aleutians wrap; the narrower frame is the real extent.
  return shifted[2] - shifted[0] < plain[2] - plain[0] ? shifted : plain;
}

/** Property prefix for the active connection type: f_dl, m_lat, and so on. */
function pfx() {
  return state.type === 'fixed' ? 'f' : 'm';
}

function quarter() {
  return meta.quarters[state.quarter];
}

function quarterId() {
  return quarter().id;
}

/** One extent per polygon part.

    A single union extent is useless for asking "is this country on screen":
    France's spans Guadeloupe to Réunion and Russia's spans the whole globe, so
    both would count as visible almost everywhere. */
function partExtents(geometry) {
  const polys =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys.map((poly) => {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const [lon, lat] of poly[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    return [w, s, e, n];
  });
}

function indexCountries() {
  for (const f of geo.features) {
    countryNames.set(f.properties.id, f.properties.name);
    countryBounds.set(f.properties.id, boundsOf(f.geometry));
    countryParts.set(f.properties.id, partExtents(f.geometry));
  }
}

/** Unified row shape so the list, summary and table work at every level.

    Below the country level the list mixes two kinds of row: the units in view,
    plus any country in view that has no unit at this level. That mirrors what
    the map draws, so nothing can be visible on screen and missing from the
    ranking. */
function activeRows(level = state.level) {
  const p = pfx();
  const rows = [];
  const push = (props, sub, rowLevel) =>
    rows.push({
      id: props.id,
      level: rowLevel,
      name: props.name || '(unnamed)',
      sub,
      dl: props[`${p}_dl`],
      ul: props[`${p}_ul`],
      lat: props[`${p}_lat`],
      tests: props[`${p}_tests`],
    });

  if (level === 0) {
    for (const f of geo.features) {
      if (f.properties[`${p}_tests`] != null) push(f.properties, f.properties.sub, 0);
    }
  } else {
    for (const f of visibleFeatures) {
      const props = f.properties;
      // Inherited values are the country's figure wearing a district's shape;
      // ranking them would repeat one number across dozens of rows.
      if (props[`${p}_tests`] == null || props[`${p}_inh`]) continue;
      push(props, countryNames.get(countryIdOf(props.sub)) ?? props.sub, level);
    }
    for (const f of fallbackCountries) push(f.properties, 'Country total', 0);
  }
  const asc = METRICS[state.metric].better === 'lower';
  return rows.sort((a, b) =>
    asc ? a[state.metric] - b[state.metric] : b[state.metric] - a[state.metric],
  );
}

/**
 * Test-weighted world average for the active quarter. Read off the country
 * frame rather than baked into meta -- it has to move with the timeline, which
 * is the whole point of the comparison.
 */
function worldAverage(metric) {
  return frames[0]?.worldMean(state.type)?.[metric] ?? null;
}

/**
 * The selected unit, ranked within its own level rather than whatever level the
 * map happens to be showing.
 *
 * A country stays resolvable at any zoom, because the country layer and its
 * frame are always loaded -- which is what lets a country selection survive the
 * fly-to that lands past the sub-national threshold.
 */
function resolveSelection() {
  if (!state.selected) return null;
  const { id, level } = state.selected;
  const rows = activeRows(level);
  const i = rows.findIndex((r) => r.id === id && r.level === level);
  return i < 0 ? null : { row: rows[i], rank: i + 1, total: rows.length, level };
}

function isSelected(row) {
  return (
    state.selected != null &&
    state.selected.id === row.id &&
    state.selected.level === row.level
  );
}

function stops() {
  return meta.types[state.type].stops[state.metric];
}

function levelLabel(level = state.level) {
  return regions.levelInfo(level)?.label ?? 'Countries';
}

/** Singular form, for talking about one unit. Chopping an "s" off the plural
    labels gives "Countrie" and "States & province", so name them outright. */
const LEVEL_NOUN = { 0: 'Country', 1: 'Province', 2: 'District' };

function levelNoun(level) {
  return LEVEL_NOUN[level] ?? levelLabel(level);
}

/* ------------------------------------------------------------------- map */

/** Colour by the active metric, with a distinct grey where nothing was
    published. Every level uses the same property names, so one expression
    serves countries, provinces and districts alike. */
function colorExpr() {
  const p = `${pfx()}_${state.metric}`;
  return [
    'case',
    ['has', p],
    rampExpression(['get', p], stops(), state.theme),
    NO_DATA[state.theme],
  ];
}

function installLayers() {
  const t = THEME[state.theme];

  map.addSource('countries', { type: 'geojson', data: geo, promoteId: 'id' });
  map.addSource('regions', { type: 'geojson', data: EMPTY, promoteId: 'id' });
  map.addSource('grid', { type: 'geojson', data: EMPTY });

  map.addLayer(
    {
      id: 'countries-fill',
      type: 'fill',
      source: 'countries',
      paint: { 'fill-color': colorExpr(), 'fill-opacity': HOVER_OPACITY },
    },
    LABEL_ANCHOR,
  );

  map.addLayer(
    {
      id: 'regions-fill',
      type: 'fill',
      source: 'regions',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': colorExpr(),
        'fill-opacity': HOVER_OPACITY,
        // Same colour as the fill, so each unit grows by a hairline and the
        // sub-tolerance slivers left by simplifying neighbours independently
        // close up instead of showing the basemap through.
        'fill-outline-color': colorExpr(),
      },
    },
    LABEL_ANCHOR,
  );

  map.addLayer(
    {
      id: 'regions-line',
      type: 'line',
      source: 'regions',
      layout: { visibility: 'none' },
      paint: { 'line-color': t.outline, 'line-width': 0.4, 'line-opacity': 0.7 },
    },
    LABEL_ANCHOR,
  );

  // Country borders sit above region fills so the country frame stays legible
  // once the map is subdivided.
  map.addLayer(
    {
      id: 'countries-line',
      type: 'line',
      source: 'countries',
      paint: { 'line-color': t.outline, 'line-width': 0.8 },
    },
    LABEL_ANCHOR,
  );

  map.addLayer(
    {
      id: 'grid-fill',
      type: 'fill',
      source: 'grid',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': rampExpression(['get', state.metric], stops(), state.theme),
        'fill-opacity': 0.82,
        'fill-outline-color': 'rgba(0,0,0,0)',
      },
    },
    LABEL_ANCHOR,
  );

  // Selection rings sit above the labels so they never get lost in dense areas.
  for (const [id, src] of [
    ['countries-selected', 'countries'],
    ['regions-selected', 'regions'],
  ]) {
    map.addLayer({
      id,
      type: 'line',
      source: src,
      paint: { 'line-color': t.hover, 'line-width': 1.8 },
      filter: ['==', ['get', 'id'], ' '],
    });
  }
}

function show(layer, visible) {
  map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
}

function refreshPaint() {
  if (!map.getLayer('countries-fill')) return;
  const t = THEME[state.theme];
  const regionView = state.view === 'regions';
  const sub = regionView && state.level > 0;

  map.setPaintProperty('countries-fill', 'fill-color', colorExpr());
  map.setPaintProperty('regions-fill', 'fill-color', colorExpr());
  map.setPaintProperty('regions-fill', 'fill-outline-color', colorExpr());
  map.setPaintProperty(
    'grid-fill',
    'fill-color',
    rampExpression(['get', state.metric], stops(), state.theme),
  );
  for (const l of ['countries-line', 'regions-line']) {
    map.setPaintProperty(l, 'line-color', t.outline);
  }
  for (const l of ['countries-selected', 'regions-selected']) {
    map.setPaintProperty(l, 'line-color', t.hover);
  }

  // The country fill stays painted underneath the sub-national layers, and how
  // strongly depends on whether anything finer is drawn on top of it:
  //   covered  -> a faint wash, because two fills at 0.78 compound to ~0.95 and
  //               bury the basemap, and only the regions should read.
  //   uncovered-> full strength, because it is the finest data that exists for
  //               that country and dimming it would hide real readings.
  show('countries-fill', regionView);
  map.setPaintProperty(
    'countries-fill',
    'fill-opacity',
    sub
      ? [
          'case',
          ['in', ['get', 'id'], ['literal', [...covered]]],
          UNDERLAY_OPACITY,
          HOVER_OPACITY,
        ]
      : HOVER_OPACITY,
  );
  show('countries-line', regionView);
  show('regions-fill', sub);
  show('regions-line', sub);
  show('grid-fill', !regionView);
  // Both rings stay live below the country level: unit ids and ISO3 codes are
  // disjoint, so filtering both on the selection matches at most one.
  show('countries-selected', regionView);
  show('regions-selected', sub);

  const sel = state.selected;
  map.setFilter('countries-selected', [
    '==',
    ['get', 'id'],
    sel && sel.level === 0 ? sel.id : ' ',
  ]);
  map.setFilter('regions-selected', [
    '==',
    ['get', 'id'],
    sub && sel && sel.level > 0 ? sel.id : ' ',
  ]);
}

function viewBounds(pad = 0.15) {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * pad;
  const dy = (b.getNorth() - b.getSouth()) * pad;
  return [
    b.getWest() - dx,
    Math.max(-85, b.getSouth() - dy),
    b.getEast() + dx,
    Math.min(85, b.getNorth() + dy),
  ];
}

/**
 * Narrow the loaded units to those actually on screen.
 *
 * Chunks are far larger than a viewport -- a level-1 chunk spans ~5000 km -- so
 * without this the list would rank provinces a continent away and still call
 * them "in view". The map keeps drawing everything loaded, which is what stops
 * regions popping in at the edges as you pan.
 */
function updateVisible() {
  const p = pfx();
  if (state.level === 0) {
    visibleFeatures = [];
    covered = new Set();
    fallbackCountries = [];
    return;
  }
  const b = map.getBounds();
  const box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  visibleFeatures = regionFeatures.filter((f) => overlaps(f._bbox, box));

  // Coverage is per level, per quarter and per connection type: a country can
  // have districts for fixed but not mobile, or in 2026 but not 2019.
  covered = new Set();
  for (const f of regionFeatures) {
    if (f.properties[`${p}_tests`] != null) {
      covered.add(countryIdOf(f.properties.sub));
    }
  }
  fallbackCountries = geo.features.filter(
    (f) =>
      !covered.has(f.properties.id) &&
      f.properties[`${p}_tests`] != null &&
      (countryParts.get(f.properties.id) ?? []).some((part) =>
        overlaps(part, box),
      ),
  );
}

function setBusy(busy) {
  $('timeline').classList.toggle('is-loading', busy);
}

/**
 * Bring every layer in line with the current quarter, zoom and viewport.
 *
 * Geometry and statistics are fetched separately and joined here: the frame
 * for the quarter is copied onto whatever features are loaded, then handed to
 * MapLibre. Playback calls this once per step and awaits it, so a frame is
 * never shown half-updated.
 */
async function syncData() {
  const token = (dataToken += 1);
  const q = quarterId();
  const level = regions.levelForZoom(map.getZoom()).level;
  const levelChanged = level !== state.level;
  state.level = level;
  // A country selection survives any zoom -- selecting a small country flies
  // past the sub-national threshold, and dropping it there would mean you could
  // never track that country across the timeline. A sub-national selection only
  // exists while its own level is drawn.
  if (levelChanged && state.selected?.level > 0 && state.selected.level !== level) {
    state.selected = null;
  }
  setBusy(true);

  try {
    const f0 = await series.loadFrame(0, q);
    if (token !== dataToken) return;
    frames[0] = f0;
    applyFrame(geo.features, f0);
    map.getSource('countries').setData(geo);

    if (level > 0) {
      const [frame, data] = await Promise.all([
        series.loadFrame(level, q),
        regions.featuresFor(level, viewBounds()),
      ]);
      if (token !== dataToken) return;
      frames[level] = frame;
      // Units that published nothing this quarter inherit their country's
      // figure rather than becoming holes in the map.
      applyFrame(data.features, frame, (f, type) =>
        f0.get(countryIdOf(f.properties.sub), type),
      );
      regionFeatures = data.features;
      map.getSource('regions').setData(data);
    } else {
      regionFeatures = [];
      map.getSource('regions').setData(EMPTY);
    }
    updateVisible();

    if (state.view === 'grid') {
      const grid = await loadLevel(
        state.type,
        q,
        levelForZoom(map.getZoom()),
        BASE,
      );
      if (token !== dataToken) return;
      map.getSource('grid').setData(grid.query(viewBounds()));
    }

    refreshPaint();
    renderPanel();
    renderTimeline();
    prefetchAhead();
  } catch (err) {
    console.error('sync failed', err);
  } finally {
    if (token === dataToken) setBusy(false);
  }
}

async function loadWorldTrend() {
  try {
    const all = await Promise.all(
      meta.quarters.map((q) => series.loadFrame(0, q.id)),
    );
    worldTrend = {};
    for (const type of Object.keys(TYPES)) {
      worldTrend[type] = all.map((f) => f.worldMean(type));
    }
    renderTrend();
  } catch (err) {
    console.warn('trend line unavailable', err);
  }
}

/**
 * Sparkline of the world average across every quarter, drawn on the same axis
 * as the slider so the marker sits under the thumb. Inset by half a thumb
 * width because a range input's travel is narrower than its track.
 */
function renderTrend() {
  const el = $('timeline-trend');
  if (!worldTrend) return;
  const rows = worldTrend[state.type];
  const values = rows.map((r) => (r ? r[state.metric] : null));
  const known = values.filter((v) => v != null);
  if (known.length < 2) return;

  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const span = hi - lo || 1;
  const n = values.length - 1 || 1;
  const x = (i) => (i / n) * 100;
  const y = (v) => 100 - ((v - lo) / span) * 100;

  const pts = values
    .map((v, i) => (v == null ? null : `${x(i).toFixed(2)},${y(v).toFixed(2)}`))
    .filter(Boolean)
    .join(' ');
  const cur = values[state.quarter];

  el.innerHTML = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" />
    </svg>
    ${
      cur == null
        ? ''
        : `<i style="left:${x(state.quarter).toFixed(2)}%;top:${y(cur).toFixed(2)}%"></i>`
    }`;
  el.title =
    `World ${METRICS[state.metric].label.toLowerCase()}, ` +
    `${formatValue(lo, state.metric)} to ${formatValue(hi, state.metric)} ` +
    `across ${meta.quarters.length} quarters`;
}

function prefetchAhead() {
  const q = quarterId();
  series.prefetch(0, q);
  if (state.level > 0) series.prefetch(state.level, q);
  if (state.view === 'grid') {
    prefetchLevel(
      state.type,
      series.quarters,
      q,
      levelForZoom(map.getZoom()),
      BASE,
    );
  }
}

/* -------------------------------------------------------------------- UI */

function segmented(el, options, current, onPick) {
  el.replaceChildren(
    ...options.map(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'radio';
      b.textContent = label;
      b.setAttribute('aria-checked', String(value === current));
      b.addEventListener('click', () => onPick(value));
      return b;
    }),
  );
}

function renderControls() {
  segmented(
    $('seg-type'),
    Object.values(TYPES).map((t) => [t.key, t.short]),
    state.type,
    (v) => set({ type: v }),
  );
  segmented(
    $('seg-metric'),
    Object.values(METRICS).map((m) => [m.key, m.short]),
    state.metric,
    (v) => set({ metric: v }),
  );
  segmented(
    $('seg-view'),
    [
      ['regions', 'Regions'],
      ['grid', 'Detail grid'],
    ],
    state.view,
    (v) => set({ view: v }),
  );

  const note = $('view-note');
  if (state.view === 'grid') {
    note.textContent = 'Measurement tiles — cells sharpen as you zoom.';
    return;
  }
  const next = regions.levelInfo(state.level + 1);
  note.textContent = next
    ? `${levelLabel()} — zoom in for ${next.label.toLowerCase()}.`
    : `${levelLabel()} — the finest level.`;
}

function renderLegend() {
  const m = METRICS[state.metric];
  const sc = stops();
  const last = sc.length - 1;
  const fmt = (v) =>
    v.toLocaleString('en-US', { maximumFractionDigits: m.decimals });

  // Ticks on the same linear value axis as the gradient. The ends carry <=/>=
  // because the ramp is anchored at the 2nd and 98th percentile and clamps
  // outside them -- a handful of readings really are past each end.
  const ticks = [0, 2, 4, last].map((i) => {
    const pct = positionOf(sc[i], sc);
    const label = i === 0 ? `≤${fmt(sc[i])}` : i === last ? `≥${fmt(sc[i])}` : fmt(sc[i]);
    const align =
      i === 0 ? 'left:0;transform:none' : i === last ? 'right:0;transform:none' : `left:${pct}%`;
    return `<span style="${align}">${label}</span>`;
  });

  $('legend').innerHTML = `
    <div class="legend__title">${m.label} · ${TYPES[state.type].short}</div>
    <p class="legend__sub">${m.unit} · ${m.better === 'lower' ? 'lower is better' : 'higher is better'}</p>
    <div class="legend__bar" style="background:${gradientCss(sc, state.theme)}"></div>
    <div class="legend__ticks">${ticks.join('')}</div>
    <div class="legend__nodata"><i style="background:${NO_DATA[state.theme]}"></i><span>No published data</span></div>
    <p class="legend__scaleNote">Scale is fixed across all quarters, so colour
      changes over time are real changes.</p>
  `;
}

function statCell(label, value) {
  return `<div class="summary__cell"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function renderSummary() {
  const el = $('summary');
  const m = METRICS[state.metric];
  const rows = activeRows();
  const world = worldAverage(state.metric);
  const picked = resolveSelection();
  const q = quarter();

  if (picked) {
    const { row, rank, total, level } = picked;
    const diff = world ? Math.round((row[state.metric] / world - 1) * 100) : null;
    // Say which level the figure is from when it is not the level on screen,
    // so a country total is never read as a district one.
    const scope = level === state.level ? '' : `${levelNoun(level)} · `;
    el.innerHTML = `
      <div class="summary__label">${row.name}${row.sub ? ` · ${row.sub}` : ''}</div>
      <p class="summary__hero">${formatValue(row[state.metric], state.metric)}
        <small>· #${rank} of ${total.toLocaleString('en-US')}</small></p>
      <p class="summary__meta">${scope}${
        diff == null ? '' : `${diff > 0 ? '+' : ''}${diff}% vs. world · `
      }${formatCount(row.tests)} tests · ${q.label}</p>
      <dl class="summary__grid">
        ${statCell('Download', formatValue(row.dl, 'dl'))}
        ${statCell('Upload', formatValue(row.ul, 'ul'))}
        ${statCell('Latency', formatValue(row.lat, 'lat'))}
      </dl>
      <div class="summary__back"><button class="link-btn" id="clear-sel" type="button">← Clear selection</button></div>
    `;
    $('clear-sel').addEventListener('click', () => set({ selected: null }));
    return;
  }

  el.innerHTML = `
    <div class="summary__label">World · ${TYPES[state.type].label}</div>
    <p class="summary__hero">${formatValue(world, state.metric)}
      <small>average ${m.label.toLowerCase()}</small></p>
    <p class="summary__meta">${q.label} · ${formatCount(q.tests[state.type])} tests · ${rows.length.toLocaleString(
      'en-US',
    )} ${levelLabel().toLowerCase()}${state.level > 0 ? ' in view' : ''}</p>
    <dl class="summary__grid">
      ${statCell('Download', formatValue(worldAverage('dl'), 'dl'))}
      ${statCell('Upload', formatValue(worldAverage('ul'), 'ul'))}
      ${statCell('Latency', formatValue(worldAverage('lat'), 'lat'))}
    </dl>
  `;
}

const LIST_CAP = 400;

function renderRanking() {
  const rows = activeRows();
  const term = state.search.trim().toLowerCase();
  const matched = term
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(term) ||
          (r.sub ?? '').toLowerCase().includes(term),
      )
    : rows;
  const shown = matched.slice(0, LIST_CAP);
  const sc = stops();
  const max = rows.length ? Math.max(...rows.map((r) => r[state.metric])) : 1;
  const rank = new Map(rows.map((r, i) => [r.id, i + 1]));

  const list = $('ranking-list');
  rowEls.clear();
  list.replaceChildren(
    ...shown.map((row) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `row${isSelected(row) ? ' is-selected' : ''}`;
      btn.innerHTML = `
        <span class="row__rank">${rank.get(row.id)}</span>
        <span class="row__cell">
          <span class="row__name">${row.name}</span>
          ${state.level > 0 ? `<span class="row__sub">${row.sub}</span>` : ''}
          <span class="row__bar"><span style="width:${Math.max(
            2,
            (row[state.metric] / max) * 100,
          )}%;background:${colorAt(row[state.metric], sc, state.theme)}"></span></span>
        </span>
        <span class="row__value">${formatNumber(row[state.metric], state.metric)}</span>`;
      btn.addEventListener('click', () => selectUnit(row.id, row.level, true));
      btn.addEventListener('mouseenter', () => setHover(row.id));
      btn.addEventListener('mouseleave', () => setHover(null));
      rowEls.set(row.id, btn);
      li.appendChild(btn);
      return li;
    }),
  );

  $('ranking-title').textContent =
    METRICS[state.metric].better === 'lower'
      ? 'Lowest latency'
      : `Fastest ${METRICS[state.metric].short.toLowerCase()}`;

  const unit = levelLabel().toLowerCase();
  const scope =
    state.level === 0
      ? `${rows.length} countries`
      : `${rows.length.toLocaleString('en-US')} ${unit} in view`;
  const floor = regions.levelInfo(state.level)?.minTests ?? meta.minTests.country;
  $('ranking-note').textContent =
    matched.length > LIST_CAP
      ? `Top ${LIST_CAP} of ${scope}, by test-weighted mean.`
      : `${scope}. Ranked by test-weighted mean; units below ${floor} tests are not published.`;
}

function renderTimeline() {
  const q = quarter();
  const slider = $('quarter-slider');
  slider.max = String(meta.quarters.length - 1);
  slider.value = String(state.quarter);
  slider.setAttribute('aria-valuetext', q.label);
  $('timeline-now').textContent = q.label;
  $('timeline-tests').textContent = `${formatCount(q.tests[state.type])} tests`;
  renderTrend();

  const years = $('timeline-years');
  if (years.childElementCount !== meta.quarters.filter((x) => x.quarter === 1).length) {
    const n = meta.quarters.length - 1 || 1;
    years.innerHTML = meta.quarters
      .map((x, i) =>
        x.quarter === 1
          ? `<span style="left:${((i / n) * 100).toFixed(2)}%">${x.year}</span>`
          : '',
      )
      .join('');
  }
}

function renderPanel() {
  renderControls();
  renderLegend();
  renderSummary();
  renderRanking();
}

function renderTable() {
  const rows = activeRows();
  const head = `
    <thead><tr>
      <th>#</th><th>${state.level === 0 ? 'Country' : levelLabel()}</th>
      <th>${state.level === 0 ? 'Continent' : 'Country'}</th>
      <th>Down (Mbps)</th><th>Up (Mbps)</th><th>Latency (ms)</th><th>Tests</th>
    </tr></thead>`;
  const body = rows
    .map(
      (r, i) => `<tr>
        <td>${i + 1}</td><td>${r.name}</td><td>${r.sub ?? ''}</td>
        <td>${formatNumber(r.dl, 'dl')}</td><td>${formatNumber(r.ul, 'ul')}</td>
        <td>${formatNumber(r.lat, 'lat')}</td><td>${r.tests.toLocaleString('en-US')}</td>
      </tr>`,
    )
    .join('');
  $('data-table').innerHTML = head + `<tbody>${body}</tbody>`;
  $('table-title').textContent =
    `${TYPES[state.type].label} · ${levelLabel().toLowerCase()}${
      state.level > 0 ? ' in view' : ''
    } · ${quarter().label} · ranked by ${METRICS[state.metric].label.toLowerCase()}`;
}

/* -------------------------------------------------------------- tooltip */

const tooltip = $('tooltip');

function metricRows(values, note) {
  const rows = Object.values(METRICS)
    .map(
      (m) =>
        `<dt>${m.label}</dt><dd class="${m.key === state.metric ? 'is-active' : ''}">${formatValue(
          values[m.key],
          m.key,
        )}</dd>`,
    )
    .join('');
  return `<dl class="tooltip__rows">${rows}</dl>${
    note ? `<p class="tooltip__foot">${note}</p>` : ''
  }`;
}

function showTooltip(point, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pad = 16;
  const x = Math.min(point.x, window.innerWidth - tooltip.offsetWidth - pad - 12);
  const y = Math.min(point.y, window.innerHeight - tooltip.offsetHeight - pad - 12);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

/* ----------------------------------------------------------- interaction */

let hoverId = null;
let hoverSource = null;

/** Highlight a unit on the map and in the list. Runs on every mousemove, so it
    touches exactly the two rows that changed rather than rescanning. */
function setHover(id, source = state.level > 0 ? 'regions' : 'countries') {
  if (hoverId === id) return;
  if (hoverId) {
    map.setFeatureState({ source: hoverSource, id: hoverId }, { hover: false });
    rowEls.get(hoverId)?.classList.remove('is-hover');
  }
  hoverId = id;
  hoverSource = source;
  if (id) {
    map.setFeatureState({ source, id }, { hover: true });
    rowEls.get(id)?.classList.add('is-hover');
  }
}

function boundsForUnit(id, level) {
  if (level > 0) {
    const f = regionFeatures.find((x) => x.properties.id === id);
    if (f) return boundsOf(f.geometry);
  }
  return countryBounds.get(id) ?? null;
}

function selectUnit(id, level, fly) {
  set({ selected: { id, level } });
  const b = fly ? boundsForUnit(id, level) : null;
  if (b) {
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
      padding: { top: 60, bottom: 90, left: 396, right: 260 },
      maxZoom: level === 0 ? 7 : 9,
      duration: 900,
    });
  }
}

function formatLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${
    lon >= 0 ? 'E' : 'W'
  }`;
}

function cellSizeKm(lat, zoom) {
  return (40075 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * The finest *published* feature under a point.
 *
 * Falls through from region to country, so a place with no unit at this level
 * -- or a unit below the test floor -- still answers with the country figure
 * rather than reading as a hole in the map.
 */
function pickFeature(point) {
  if (state.view === 'grid') {
    const hit = map.queryRenderedFeatures(point, { layers: ['grid-fill'] })[0];
    return hit ? { kind: 'grid', f: hit } : null;
  }
  const k = pfx();
  if (state.level > 0 && map.getLayer('regions-fill')) {
    const r = map
      .queryRenderedFeatures(point, { layers: ['regions-fill'] })
      .find((f) => f.properties[`${k}_tests`] != null);
    if (r) return { kind: 'region', f: r };
  }
  const c = map.queryRenderedFeatures(point, { layers: ['countries-fill'] })[0];
  return c ? { kind: 'country', f: c } : null;
}

function wireMapEvents() {
  map.on('mousemove', (e) => {
    const canvas = map.getCanvas();
    const pick = pickFeature(e.point);

    if (!pick) {
      setHover(null);
      hideTooltip();
      canvas.style.cursor = '';
      return;
    }

    const p = pick.f.properties;

    if (pick.kind === 'grid') {
      const km = cellSizeKm(p.clat, levelForZoom(map.getZoom()));
      canvas.style.cursor = 'crosshair';
      showTooltip(
        e.originalEvent,
        `<div class="tooltip__name">${formatLatLon(p.clat, p.lon)}</div>${metricRows(
          p,
          `${km.toFixed(km < 10 ? 1 : 0)} km cell · ${formatCount(p.tests)} tests · ${quarter().label}`,
        )}`,
      );
      return;
    }

    const isRegion = pick.kind === 'region';
    setHover(p.id, isRegion ? 'regions' : 'countries');
    canvas.style.cursor = 'pointer';

    const k = pfx();
    const label = p.name || '(unnamed)';
    // Say plainly when a reading is coarser than the level being shown, so a
    // country figure is never mistaken for a district one.
    const parent = countryNames.get(countryIdOf(p.sub));
    const coarse = `Country total — no ${levelLabel().toLowerCase()} published here`;
    const where =
      isRegion && !p[`${k}_inh`]
        ? `${levelLabel()}${parent ? ` · ${parent}` : ''}`
        : state.level > 0
          ? coarse
          : TYPES[state.type].label;
    showTooltip(
      e.originalEvent,
      p[`${k}_tests`] != null
        ? `<div class="tooltip__name">${label}</div>${metricRows(
            { dl: p[`${k}_dl`], ul: p[`${k}_ul`], lat: p[`${k}_lat`] },
            `${where} · ${formatCount(p[`${k}_tests`])} tests · ${quarter().label}`,
          )}`
        : `<div class="tooltip__name">${label}</div>
           <p class="tooltip__foot">No ${TYPES[state.type].short.toLowerCase()} data published for ${quarter().label}.</p>`,
    );
  });

  map.on('mouseout', () => {
    setHover(null);
    hideTooltip();
  });

  map.on('click', (e) => {
    if (state.view !== 'regions') return;
    const k = pfx();
    const pick = pickFeature(e.point);
    const p = pick?.f.properties;
    if (!p || p[`${k}_tests`] == null) {
      set({ selected: null });
      return;
    }
    // An inherited unit is showing its country's number, so select the country.
    const country = pick.kind === 'country' || p[`${k}_inh`];
    set({
      selected: country
        ? { id: pick.kind === 'country' ? p.id : countryIdOf(p.sub), level: 0 }
        : { id: p.id, level: state.level },
    });
  });

  let timer;
  const onMove = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      syncData();
    }, 140);
  };
  map.on('moveend', onMove);
  map.on('zoomend', onMove);
}

/* ------------------------------------------------------------- playback */

async function playLoop() {
  while (state.playing) {
    const last = meta.quarters.length - 1;
    state.quarter = state.quarter >= last ? 0 : state.quarter + 1;
    renderTimeline();
    // Awaited, so a step never paints a half-loaded quarter; the pause below
    // is on top of however long the data took.
    await syncData();
    if (!state.playing) break;
    await delay(state.speed);
  }
}

function setPlaying(on) {
  if (state.playing === on) return;
  state.playing = on;
  const btn = $('play');
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Pause the timeline' : 'Play the timeline');
  $('play-icon').textContent = on ? '❚❚' : '▶';
  if (on) playLoop();
}

/* ----------------------------------------------------------------- state */

function set(patch) {
  const prevTheme = state.theme;
  Object.assign(state, patch);

  if (patch.theme && patch.theme !== prevTheme) {
    // Swap the two raster sources in place rather than calling setStyle():
    // a full style reload would tear down the data sources and layers, and
    // re-adding them depends on a style-load event that does not reliably
    // land before the next interaction.
    document.documentElement.dataset.theme = state.theme;
    map.getSource('basemap').setTiles(cartoTiles(THEME[state.theme].basemap));
    map.getSource('labels').setTiles(cartoTiles(THEME[state.theme].labels));
    map.setPaintProperty('bg', 'background-color', THEME[state.theme].surface);
  }

  if (patch.view !== undefined) state.selected = null;

  refreshPaint();
  if (patch.type !== undefined || patch.view !== undefined || patch.quarter !== undefined) {
    syncData();
  }
  renderPanel();
  renderTimeline();
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  [meta, geo] = await Promise.all([
    fetchJSON('data/meta.json'),
    fetchJSON('data/countries.geojson'),
  ]);
  if (!meta.quarters?.length) throw new Error('meta.json has no quarters');
  indexCountries();
  regions = new RegionStore(meta, BASE);
  series = new SeriesStore(meta, BASE);
  state.quarter = meta.quarters.length - 1;

  $('quarter-label').textContent =
    `${meta.quarters[0].label} – ${meta.quarters.at(-1).label}`;

  map = new MapLibreMap({
    container: 'map',
    style: baseStyle(state.theme),
    center: [8, 26],
    zoom: 1.6,
    minZoom: 0.6,
    maxZoom: 13,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: { compact: true },
  });
  map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

  await new Promise((resolve) => map.on('load', resolve));
  if (import.meta.env.DEV) window.__map = map;
  installLayers();
  refreshPaint();
  wireMapEvents();
  renderTimeline();
  await syncData();
  renderPanel();

  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderRanking();
  });
  $('theme-toggle').addEventListener('click', () =>
    set({ theme: state.theme === 'dark' ? 'light' : 'dark' }),
  );
  $('show-table').addEventListener('click', () => {
    renderTable();
    $('table-dialog').showModal();
  });
  $('table-close').addEventListener('click', () => $('table-dialog').close());

  $('quarter-slider').addEventListener('input', (e) => {
    setPlaying(false);
    set({ quarter: Number(e.target.value) });
  });
  $('play').addEventListener('click', () => setPlaying(!state.playing));
  $('speed').addEventListener('change', (e) => {
    state.speed = Number(e.target.value);
  });

  loadWorldTrend();

  const loader = $('loading');
  loader.classList.add('is-done');
  setTimeout(() => {
    loader.hidden = true;
  }, 450);
  $('map').setAttribute('aria-hidden', 'false');
}

boot().catch((err) => {
  console.error(err);
  $('loading').innerHTML = `<p>Could not load the map data.<br><small>${err.message}</small></p>`;
});
