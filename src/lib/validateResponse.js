// ======================================================================
// Response-shape validator
// ----------------------------------------------------------------------
// Each API endpoint has an expected skeleton. When a response doesn't
// match — missing required arrays/objects, wrong types — we don't let
// the malformed data propagate into JSX where it'll crash with opaque
// "cannot read property X of undefined". We log + return a sanitized
// default so the view can render an empty state instead.
//
// USAGE:
//   const raw = await fetch('/api/target-board').then(r => r.json());
//   const data = validate(raw, SHAPES.targetBoard);
//   // data is guaranteed to have the expected shape; missing fields
//   // get safe defaults (arrays → [], objects → {}, else pass-through)
// ======================================================================

// ----- Endpoint shape registry -----
// Each shape describes the top-level fields we care about and their
// default values if missing. Nested arrays and objects get defaulted
// too. Primitives are left alone (the view handles them via fmt.* etc).
export const SHAPES = {
  targetBoard: {
    targets: [],
    source: null,
    generatedAt: null,
    universe: null,
    universeSize: 0,
    tickersScanned: 0,
    cached: false,
  },
  prophet: {
    picks: [],
    stats: {},
    universe: null,
    generatedAt: null,
    // 4c-2: optional sieve telemetry from russell snapshots. Absent on
    // largecap/all (no sieve runs there). Set as `null` here so the
    // validator pipes the field through if present without dropping it.
    sieve: null,
  },
  prophetPortfolio: {
    // 4e-1: paper-portfolio state, swaps, equity curve + window metrics.
    // Pre-W5 the state field will be null and arrays will be empty; the
    // UI (4e-2) renders an engine-pending placeholder in that case.
    state: null,
    swaps: [],
    equityCurve: [],
    metrics: {},
    universe: null,
    generatedAt: null,
  },
  catalyst: {
    picks: [],
    generatedAt: null,
  },
  earningsBoard: {
    setups: [],
    universeChecked: 0,
    windowDays: 7,
    cached: false,
    generatedAt: null,
  },
  insiderBoard: {
    rows: [],
    universeChecked: 0,
    windowDays: 90,
    cached: false,
    generatedAt: null,
  },
  sentimentBoard: {
    rows: [],
    universeChecked: 0,
    sort: 'bullish',
    cached: false,
    generatedAt: null,
  },
  optionsFlow: {
    candidates: [],
    proxyNote: null,
    universeChecked: 0,
    generatedAt: null,
  },
  regime: {
    regime: 'neutral',
    conviction: 'unknown',
    rationale: '',
    vol: {},
    rates: {},
    riskAppetite: {},
  },
  backtest: {
    ok: false,
    summary: {},
    byTier: {},
    byDirection: {},
    trades: {},
    config: {},
  },
  engineTest: {
    ticker: null,
    price: null,
    priceChangePct: null,
    durationMs: 0,
    target: null,
    regime: null,
    sectorRanking: null,
    analysts: {},
    barsLoaded: 0,
    totalSignals: 0,
  },
  chartAnalysis: {
    ticker: null,
    bars: [],
    signal: { action: 'HOLD', confidence: 0, bullPoints: [], bearPoints: [] },
    indicators: { latest: {} },
    setups: [],
    narrative: null,
  },
  williams: {
    candidates: [],
  },
  lynch: {
    candidates: [],
  },
  analystsStatus: {
    analysts: [],
  },
};

// Deep-merge-with-defaults: if `raw[k]` exists and matches the expected
// type, use it; else use the shape's default. We don't recurse into
// nested objects by default — the view's own optional-chaining handles
// that. The goal is just to guarantee top-level shape.
export function validate(raw, shape, endpoint = 'unknown') {
  if (!raw || typeof raw !== 'object') {
    console.warn(`[validateResponse] ${endpoint}: response is not an object, using defaults`, raw);
    return { ...shape };
  }

  const out = {};
  let anyMismatches = false;
  const mismatches = [];

  for (const [key, defaultVal] of Object.entries(shape)) {
    const got = raw[key];

    if (got === undefined || got === null) {
      out[key] = defaultVal;
      if (defaultVal !== null) {
        mismatches.push(`${key}=missing`);
        anyMismatches = true;
      }
      continue;
    }

    // Type check against default
    if (Array.isArray(defaultVal)) {
      if (Array.isArray(got)) {
        out[key] = got;
      } else {
        mismatches.push(`${key}=expected array, got ${typeof got}`);
        anyMismatches = true;
        out[key] = [];
      }
    } else if (typeof defaultVal === 'object' && defaultVal !== null) {
      if (typeof got === 'object' && !Array.isArray(got)) {
        out[key] = got;
      } else {
        mismatches.push(`${key}=expected object, got ${typeof got}`);
        anyMismatches = true;
        out[key] = defaultVal;
      }
    } else {
      // Primitive — pass through as-is (view handles null/undefined via fmt.*)
      out[key] = got;
    }
  }

  // Preserve extra keys we didn't explicitly declare — view may need them
  for (const key of Object.keys(raw)) {
    if (!(key in shape)) out[key] = raw[key];
  }

  if (anyMismatches) {
    console.warn(`[validateResponse] ${endpoint}: shape mismatches: ${mismatches.join(', ')}`);
  }

  return out;
}

// Convenience wrapper that combines fetch + validate in one call.
// Returns { data, error } so callers can handle failures without try/catch.
export async function fetchAndValidate(url, shape, endpoint) {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      return { data: null, error: `HTTP ${r.status}` };
    }
    const raw = await r.json();
    return { data: validate(raw, shape, endpoint || url), error: null };
  } catch (err) {
    return { data: null, error: err.message || 'fetch failed' };
  }
}

// Retry wrapper for transient Netlify edge errors. Specifically targets the
// "DNS cache overflow" / 503 / 502 patterns that hit during cold-start of
// large-universe scans. The function itself is healthy — Netlify's edge
// proxy is just saying "try again in a sec."
//
// Strategy: 3 attempts total, exponential backoff (1s, 2.5s), only retries
// on 502/503/504 or network errors. 4xx and 200-with-error-body are NOT
// retried because they're real failures, not transient.
export async function fetchWithRetry(url, { maxAttempts = 3, signal } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, { signal });
      // 502/503/504 = retry; everything else (including 4xx) returns to caller
      if ([502, 503, 504].includes(r.status) && attempt < maxAttempts) {
        const wait = attempt === 1 ? 1000 : 2500;
        console.warn(`[fetchWithRetry] ${url} got ${r.status}, retrying in ${wait}ms (${attempt}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      return r;
    } catch (err) {
      lastErr = err;
      // Network error — retry unless aborted
      if (err.name === 'AbortError') throw err;
      if (attempt < maxAttempts) {
        const wait = attempt === 1 ? 1000 : 2500;
        console.warn(`[fetchWithRetry] ${url} network error, retrying in ${wait}ms (${attempt}/${maxAttempts}):`, err.message);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
    }
  }
  throw lastErr || new Error('fetchWithRetry exhausted retries');
}
