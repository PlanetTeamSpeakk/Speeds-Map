/**
 * Colour and metric configuration.
 *
 * Every metric on this map encodes *magnitude*, so the ramp is sequential:
 * one hue, monotone lightness, light->dark. The blue ramp below is the
 * documented sequential scale (steps 100..700).
 *
 * The anchor flips per theme so that "more" always means "more ink relative to
 * the surface": on the light basemap low values sit at step 100 and recede;
 * on the dark basemap low values sit at step 700 and recede instead. Both
 * orders are monotone in lightness with every adjacent gap over the dL 0.06
 * floor (checked with the palette validator; the ordinal light-end gate does
 * not apply here -- a choropleth is sequential encoding, where the step
 * nearest the surface is allowed to recede).
 *
 * "No data" is deliberately NOT a step on this ramp. It gets a neutral grey so
 * that absence of measurement can never be misread as a low reading.
 */

const BLUE = {
  100: '#cde2fb',
  200: '#9ec5f4',
  300: '#6da7ec',
  400: '#3987e5',
  500: '#256abf',
  600: '#184f95',
  700: '#0d366b',
};

const RAMP_STEPS = [100, 200, 300, 400, 500, 600, 700];

export const RAMP = {
  light: RAMP_STEPS.map((s) => BLUE[s]),
  dark: RAMP_STEPS.map((s) => BLUE[s]).reverse(),
};

export const NO_DATA = { light: '#dedcd5', dark: '#2c2c2a' };

export const THEME = {
  dark: {
    surface: '#12161c',
    basemap: 'dark_nolabels',
    labels: 'dark_only_labels',
    outline: 'rgba(255,255,255,0.22)',
    hover: '#ffffff',
  },
  light: {
    surface: '#fcfcfb',
    basemap: 'light_nolabels',
    labels: 'light_only_labels',
    outline: 'rgba(11,11,11,0.25)',
    hover: '#0b0b0b',
  },
};

/** The three measures, in the order they appear in the binary grid blocks. */
export const METRICS = {
  dl: {
    key: 'dl',
    label: 'Download',
    short: 'Down',
    unit: 'Mbps',
    better: 'higher',
    decimals: 1,
    describe: 'Test-weighted mean download throughput.',
  },
  ul: {
    key: 'ul',
    label: 'Upload',
    short: 'Up',
    unit: 'Mbps',
    better: 'higher',
    decimals: 1,
    describe: 'Test-weighted mean upload throughput.',
  },
  lat: {
    key: 'lat',
    label: 'Latency',
    short: 'Latency',
    unit: 'ms',
    better: 'lower',
    decimals: 0,
    describe: 'Test-weighted mean idle round-trip time.',
  },
};

export const TYPES = {
  fixed: { key: 'fixed', label: 'Fixed broadband', short: 'Fixed' },
  mobile: { key: 'mobile', label: 'Mobile', short: 'Mobile' },
};

/*
 * The scale is continuous. `stops` are the values the ramp colours are pinned
 * to -- test-weighted quantiles from the ETL -- and everything between them is
 * interpolated. Direction never flips: darker/brighter always means a larger
 * number. For latency that means the deep end is the *worst* end, which the
 * legend says out loud rather than encoding through hue.
 *
 * All three renderings of the scale interpolate in sRGB and therefore agree
 * exactly: MapLibre's `interpolate`, the CSS gradient in the legend, and
 * mixHex() for the list bars. Switching any one of them to a perceptual space
 * would silently desynchronise the other two.
 */

/** MapLibre `interpolate` expression pinning the ramp to `stops`. */
export function rampExpression(input, stops, theme) {
  const ramp = RAMP[theme];
  const expr = ['interpolate', ['linear'], input];
  stops.forEach((s, i) => expr.push(s, ramp[i]));
  return expr;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)}, ${Math.round(
    x[1] + (y[1] - x[1]) * t,
  )}, ${Math.round(x[2] + (y[2] - x[2]) * t)})`;
}

/** Ramp colour for a value, clamped at both ends like the map expression. */
export function colorAt(value, stops, theme) {
  const ramp = RAMP[theme];
  if (value == null || Number.isNaN(value)) return NO_DATA[theme];
  if (value <= stops[0]) return ramp[0];
  const last = stops.length - 1;
  if (value >= stops[last]) return ramp[last];
  let i = 0;
  while (i < last && value > stops[i + 1]) i += 1;
  const span = stops[i + 1] - stops[i];
  return mixHex(ramp[i], ramp[i + 1], span > 0 ? (value - stops[i]) / span : 0);
}

/**
 * CSS gradient for the legend, laid out on a **linear value axis** so a colour
 * read off the map lands at the right number on the bar. The colour stops are
 * placed at their true positions, which is why the gradient looks unevenly
 * spaced -- that unevenness is the shape of the distribution.
 */
export function gradientCss(stops, theme) {
  const ramp = RAMP[theme];
  const lo = stops[0];
  const span = stops[stops.length - 1] - lo || 1;
  const parts = stops.map(
    (s, i) => `${ramp[i]} ${(((s - lo) / span) * 100).toFixed(2)}%`,
  );
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Where a value sits along that same linear axis, as a percentage. */
export function positionOf(value, stops) {
  const lo = stops[0];
  const span = stops[stops.length - 1] - lo || 1;
  return Math.max(0, Math.min(100, ((value - lo) / span) * 100));
}

/** Bare number at the metric's precision. Every surface -- map tooltip, list,
    summary, table -- goes through this so the same reading never appears as
    both 423.4 and 423.5. */
export function formatNumber(value, metric) {
  if (value == null || Number.isNaN(value)) return '--';
  const m = METRICS[metric];
  return value.toLocaleString('en-US', {
    minimumFractionDigits: m.decimals,
    maximumFractionDigits: m.decimals,
  });
}

export function formatValue(value, metric) {
  if (value == null || Number.isNaN(value)) return '--';
  return `${formatNumber(value, metric)} ${METRICS[metric].unit}`;
}

export function formatCount(n) {
  if (n == null) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
