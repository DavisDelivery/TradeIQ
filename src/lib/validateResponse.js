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
  },
  catalyst: {
    picks: [],
    generatedAt: null,
  },
  earningsBoard: {
    setups: [],
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
