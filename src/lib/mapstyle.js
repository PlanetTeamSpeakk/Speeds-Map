import { THEME } from './palette.js';

const SUBDOMAINS = ['a', 'b', 'c'];

const OSM_ATTRIB =
  '<a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap</a> contributors, ' +
  '<a href="https://carto.com/attributions">&copy; CARTO</a>';

export function cartoTiles(set) {
  return SUBDOMAINS.map(
    (s) => `https://${s}.basemaps.cartocdn.com/${set}/{z}/{x}/{y}@2x.png`,
  );
}

/**
 * A deliberately plain raster basemap: no key, no account, and label-free so
 * the choropleth owns the colour. Place names come back on a separate layer
 * that sits above the data, which is where a choropleth wants them.
 */
export function baseStyle(theme) {
  const t = THEME[theme];
  return {
    version: 8,
    // No glyphs entry: every label on this map is a raster tile, so the style
    // never needs a font stack.
    sources: {
      basemap: {
        type: 'raster',
        tiles: cartoTiles(t.basemap),
        tileSize: 256,
        maxzoom: 19,
        attribution: OSM_ATTRIB,
      },
      labels: {
        type: 'raster',
        tiles: cartoTiles(t.labels),
        tileSize: 256,
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': t.surface } },
      { id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-opacity': 1 } },
      // Everything data-bearing is inserted before this anchor.
      {
        id: 'labels',
        type: 'raster',
        source: 'labels',
        paint: { 'raster-opacity': 0.9 },
      },
    ],
  };
}

export const LABEL_ANCHOR = 'labels';
