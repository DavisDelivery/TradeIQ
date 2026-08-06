// THEME-1 (2026-08-06) — theme-aware colours for charts.
//
// Tailwind utilities became token-driven, so every CSS class follows the
// theme automatically. Charts cannot: recharts and lightweight-charts take
// colours as JavaScript values, so ~90 hardcoded hexes across the chart
// components stayed dark-mode-only. Measured against the light page
// (#f5f6f8) they are not merely off-palette, they are unreadable — the
// signature green #14e89a lands at 1.49:1, amber #fbbf24 at 1.54:1, sky
// #38bdf8 at 1.98:1. Every chart was effectively invisible in the DEFAULT
// theme.
//
// Rather than duplicate a second palette here and let the two drift, this
// reads the SAME custom properties tailwind.config.js emits. One source of
// truth: change a token and the charts follow.
//
// Values are resolved lazily and re-read per call rather than cached at
// module load, because the theme toggle can flip after import. Chart
// components already rebuild on their own dependencies, so a fresh read
// costs a getComputedStyle and nothing else.

const FALLBACK = {
  up: '#047857',
  down: '#be123c',
  accent: '#0369a1',
  violet: '#6d28d9',
  amber: '#b45309',
  axis: '#525252',
  grid: '#d4d4d4',
  surface: '#ffffff',
};

/** Read one `--c-<family>-<shade>` token as an `rgb()` string. */
function token(name, fallback) {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--c-${name}`).trim();
    // Tokens are stored as bare channels ("4 120 87") so Tailwind can apply
    // an alpha modifier; wrap them for direct JS use.
    return raw ? `rgb(${raw})` : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Semantic chart palette for the ACTIVE theme.
 *
 * Named by MEANING, not hue — a caller asking for `up` keeps working if the
 * palette changes, and the gain/loss pair stays the one place to revisit if
 * red-green legibility ever needs addressing.
 */
export function chartTheme() {
  return {
    up: token('emerald-400', FALLBACK.up),
    down: token('rose-400', FALLBACK.down),
    accent: token('sky-400', FALLBACK.accent),
    violet: token('violet-400', FALLBACK.violet),
    amber: token('amber-400', FALLBACK.amber),
    cyan: token('sky-300', FALLBACK.accent),
    fuchsia: token('fuchsia-400', FALLBACK.violet),
    /** Axis lines. */
    axis: token('neutral-500', FALLBACK.axis),
    /** Tick labels and legend text — one step lighter than body copy. */
    tick: token('neutral-500', FALLBACK.axis),
    /** Body/label text drawn inside a chart. */
    ink: token('neutral-200', '#262626'),
    /** Deliberately de-emphasised text (n/a markers, footnotes). */
    muted: token('neutral-600', FALLBACK.axis),
    /** Gridlines and hairline separators. */
    grid: token('neutral-800', FALLBACK.grid),
    /** Hover cursor wash behind the focused column/row. */
    cursor: token('neutral-900', '#e5e5e5'),
    /** Chart background — transparent inherits the panel, which is usually right. */
    surface: 'transparent',
  };
}

/**
 * Conviction-tier accents (A/B/C/D), theme-aware.
 *
 * Lives here rather than in formatters so there is exactly one place where a
 * chart-adjacent colour is chosen. The old literals were dark-mode hexes that
 * measured under 2:1 on the light page.
 */
export function tierPalette() {
  const t = chartTheme();
  return { A: t.up, B: t.accent, C: t.amber, D: t.muted };
}

/** True when the light theme is active (charts occasionally need to branch). */
export function isLightTheme() {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('theme-light');
}
