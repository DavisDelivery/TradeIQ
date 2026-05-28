// GET /api/diag-fundamentals-v1?ticker=NVDA&periodEnd=2024-09-30
//
// Phase 4w W1 probe — diagnostic-only. Surfaces raw responses from
// Massive's (rebranded Polygon's) three new Fundamentals endpoints
// (replacing the sunsetting VX endpoint) plus the legacy VX response for
// side-by-side comparison. Used to verify documentation against actual
// API behaviour AND to test historical coverage depth.
//
// Per kickoff: "For local probe work, ask Chad to add the key to your env
// or run probes against the deployed Netlify function via a temporary
// diagnostic endpoint." This endpoint mirrors the diag-insider-pit
// pattern from W1c — the orchestrator approved that probe to remain
// permanent and gated by the "private URL" model. Phase 4w follows the
// same precedent: ship the probe with the W1 design PR; orchestrator
// decides at review whether to remove before W2 merges or keep as a
// permanent diagnostic surface.
//
// The endpoint calls each of:
//   - /stocks/financials/v1/balance-sheets
//   - /stocks/financials/v1/cash-flow-statements
//   - /stocks/financials/v1/income-statements
//   - /vX/reference/financials                    (legacy VX for compare)
// with the supplied ticker. Returns the raw response bodies (truncated
// to the first result), per-endpoint row counts, oldest available
// period_end (for historical depth probe), and a side-by-side field
// comparison so the design.md report can be evidence-based, not
// docs-only.

import type { Handler } from '@netlify/functions';
import { createLogger } from './shared/logger';

const log = createLogger('diag-fundamentals-v1');

// Phase 4w W2 plan-resolved: the Massive Fundamentals add-on is a SEPARATE
// subscription/key from the Stocks Developer (prices/aggregates) key. The
// three new endpoints sit at api.massive.com and authenticate with
// MASSIVE_FUNDAMENTALS_API_KEY; the legacy VX endpoint stays at
// api.polygon.io + POLYGON_API_KEY for side-by-side until the June 22, 2026
// VX sunset.
const MASSIVE = 'https://api.massive.com';
const POLYGON = 'https://api.polygon.io';

function massiveKey(): string {
  const k = process.env.MASSIVE_FUNDAMENTALS_API_KEY;
  if (!k) throw new Error('MASSIVE_FUNDAMENTALS_API_KEY not set');
  return k;
}
function polygonKey(): string {
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error('POLYGON_API_KEY not set');
  return k;
}

interface EndpointProbe {
  url: string;
  status: number;
  durationMs: number;
  rateLimitHeaders: Record<string, string>;
  resultCount: number;
  /** First record from results[], or null if empty. */
  sampleResult: unknown;
  /** Distinct top-level field names across sampleResult — for field-mapping discovery. */
  sampleFieldNames: string[];
  /** Pagination next_url if present. */
  hasNextUrl: boolean;
  errorBody?: string;
}

interface HistoricalDepthProbe {
  /** Earliest period_end found across the response. */
  oldestPeriodEnd: string | null;
  /** Latest period_end found. */
  newestPeriodEnd: string | null;
  /** Per-fiscal_year row count for visualising coverage shape. */
  rowsByYear: Record<string, number>;
}

interface DiagResponse {
  ok: boolean;
  ticker: string;
  periodEnd: string;
  endpoints: {
    'balance-sheets': EndpointProbe;
    'cash-flow-statements': EndpointProbe;
    'income-statements': EndpointProbe;
    'vx-legacy': EndpointProbe;
  };
  historicalDepth: {
    'balance-sheets': HistoricalDepthProbe;
    'income-statements': HistoricalDepthProbe;
  };
  fieldMappingHints: Record<string, string[]>;
  notes: string[];
}

async function probeEndpoint(url: string): Promise<EndpointProbe> {
  const started = Date.now();
  try {
    const res = await fetch(url);
    const durationMs = Date.now() - started;
    const rateLimitHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.toLowerCase().startsWith('x-ratelimit') || k.toLowerCase() === 'retry-after') {
        rateLimitHeaders[k] = v;
      }
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        url: redact(url),
        status: res.status,
        durationMs,
        rateLimitHeaders,
        resultCount: 0,
        sampleResult: null,
        sampleFieldNames: [],
        hasNextUrl: false,
        errorBody: body.slice(0, 500),
      };
    }
    const body = (await res.json()) as { results?: unknown[]; next_url?: string };
    const results = Array.isArray(body.results) ? body.results : [];
    const sample = results[0] ?? null;
    const fieldNames =
      sample && typeof sample === 'object' && sample !== null
        ? Object.keys(sample as Record<string, unknown>).sort()
        : [];
    return {
      url: redact(url),
      status: res.status,
      durationMs,
      rateLimitHeaders,
      resultCount: results.length,
      sampleResult: sample,
      sampleFieldNames: fieldNames,
      hasNextUrl: Boolean(body.next_url),
    };
  } catch (err: unknown) {
    return {
      url: redact(url),
      status: 0,
      durationMs: Date.now() - started,
      rateLimitHeaders: {},
      resultCount: 0,
      sampleResult: null,
      sampleFieldNames: [],
      hasNextUrl: false,
      errorBody: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeHistoricalDepth(
  baseUrl: string,
  ticker: string,
): Promise<HistoricalDepthProbe> {
  // Pull 100 rows with no date filter, sorted asc by period_end, to see
  // how far back the endpoint reaches.
  const url =
    `${baseUrl}?tickers=${encodeURIComponent(ticker)}&timeframe=quarterly&limit=100` +
    `&sort=period_end.asc&apiKey=${massiveKey()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { oldestPeriodEnd: null, newestPeriodEnd: null, rowsByYear: {} };
    }
    const body = (await res.json()) as { results?: Array<{ period_end?: string; fiscal_year?: number }> };
    const rows = Array.isArray(body.results) ? body.results : [];
    const periods = rows.map((r) => r.period_end).filter((d): d is string => typeof d === 'string').sort();
    const rowsByYear: Record<string, number> = {};
    for (const r of rows) {
      const y = String(r.fiscal_year ?? (r.period_end ? r.period_end.slice(0, 4) : 'unknown'));
      rowsByYear[y] = (rowsByYear[y] ?? 0) + 1;
    }
    return {
      oldestPeriodEnd: periods[0] ?? null,
      newestPeriodEnd: periods.at(-1) ?? null,
      rowsByYear,
    };
  } catch {
    return { oldestPeriodEnd: null, newestPeriodEnd: null, rowsByYear: {} };
  }
}

function redact(url: string): string {
  return url.replace(/apiKey=[^&]+/g, 'apiKey=REDACTED');
}

export const handler: Handler = async (event) => {
  const ticker = (event.queryStringParameters?.ticker ?? 'NVDA').toUpperCase().trim();
  const periodEnd = (event.queryStringParameters?.periodEnd ?? '2024-09-30').trim();

  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) {
    return json(400, { ok: false, error: 'ticker must be uppercase 1-10 chars' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    return json(400, { ok: false, error: 'periodEnd must be YYYY-MM-DD' });
  }

  log.info('probe_start', { ticker, periodEnd });

  const mKey = massiveKey();
  const pKey = polygonKey();
  const bsUrl = `${MASSIVE}/stocks/financials/v1/balance-sheets?tickers=${ticker}&period_end.lte=${periodEnd}&timeframe=quarterly&limit=5&sort=period_end.desc&apiKey=${mKey}`;
  const cfUrl = `${MASSIVE}/stocks/financials/v1/cash-flow-statements?tickers=${ticker}&period_end.lte=${periodEnd}&timeframe=quarterly&limit=5&sort=period_end.desc&apiKey=${mKey}`;
  const isUrl = `${MASSIVE}/stocks/financials/v1/income-statements?tickers=${ticker}&period_end.lte=${periodEnd}&timeframe=quarterly&limit=5&sort=period_end.desc&apiKey=${mKey}`;
  // VX stays on api.polygon.io + POLYGON_API_KEY until the June 22, 2026 sunset.
  const vxUrl = `${POLYGON}/vX/reference/financials?ticker=${ticker}&limit=5&timeframe=quarterly&order=desc&period_of_report_date.lte=${periodEnd}&apiKey=${pKey}`;

  const bsHistUrl = `${MASSIVE}/stocks/financials/v1/balance-sheets`;
  const isHistUrl = `${MASSIVE}/stocks/financials/v1/income-statements`;

  try {
    const [bsProbe, cfProbe, isProbe, vxProbe, bsDepth, isDepth] = await Promise.all([
      probeEndpoint(bsUrl),
      probeEndpoint(cfUrl),
      probeEndpoint(isUrl),
      probeEndpoint(vxUrl),
      probeHistoricalDepth(bsHistUrl, ticker),
      probeHistoricalDepth(isHistUrl, ticker),
    ]);

    // Field-mapping hints — for each VX field used by getFundamentals,
    // surface candidate fields in the new endpoint responses.
    const vxFieldsUsed = [
      'income_statement.revenues',
      'income_statement.basic_earnings_per_share',
      'income_statement.gross_profit',
      'income_statement.operating_income_loss',
      'balance_sheet.long_term_debt',
      'balance_sheet.equity',
      'filing_date',
      'end_date',
      'fiscal_period',
    ];
    const fieldMappingHints: Record<string, string[]> = {};
    for (const vxField of vxFieldsUsed) {
      const tail = vxField.split('.').pop() ?? vxField;
      const tailNoUnderscore = tail.replace(/_/g, '');
      const candidates: string[] = [];
      const allNewFields = [
        ...bsProbe.sampleFieldNames.map((f) => `balance-sheets:${f}`),
        ...isProbe.sampleFieldNames.map((f) => `income-statements:${f}`),
        ...cfProbe.sampleFieldNames.map((f) => `cash-flow-statements:${f}`),
      ];
      for (const f of allNewFields) {
        const fieldName = f.split(':')[1];
        // Exact match
        if (fieldName === tail) candidates.push(f);
        // Strip prefix/suffix differences (revenues → revenue, operating_income_loss → operating_income)
        else if (fieldName.replace(/s$/, '').replace(/_loss$/, '') === tail.replace(/s$/, '').replace(/_loss$/, '')) {
          candidates.push(`${f} (semantic match)`);
        } else if (fieldName.replace(/_/g, '') === tailNoUnderscore) {
          candidates.push(`${f} (underscore match)`);
        }
      }
      fieldMappingHints[vxField] = candidates;
    }

    const notes: string[] = [];
    if (bsProbe.status === 401 || isProbe.status === 401) {
      notes.push(
        'AUTH FAILURE: 401 on one or more new endpoints. Plan-access prerequisite may not be cleared — confirm Stocks Advanced or Stocks Financials Add-on covers the new endpoints before W2.',
      );
    }
    if (bsProbe.status === 403 || isProbe.status === 403) {
      notes.push(
        'FORBIDDEN: 403 on one or more new endpoints. Plan does not include the new endpoints — escalate to orchestrator.',
      );
    }
    if (bsDepth.oldestPeriodEnd && bsDepth.oldestPeriodEnd < '2018-01-01') {
      notes.push(
        `HISTORICAL DEPTH UNLOCK: Balance Sheets oldest period_end is ${bsDepth.oldestPeriodEnd} — pre-2018 coverage available. The VX 2018-2021 fundamental cliff is likely a VX-specific limit, not a provider archive limit.`,
      );
    }
    if (vxProbe.status === 410 || vxProbe.status === 404) {
      notes.push(
        `VX SUNSET: legacy endpoint returns ${vxProbe.status}. Migration is no longer optional — must ship before this status spreads to production calls.`,
      );
    }

    const body: DiagResponse = {
      ok: true,
      ticker,
      periodEnd,
      endpoints: {
        'balance-sheets': bsProbe,
        'cash-flow-statements': cfProbe,
        'income-statements': isProbe,
        'vx-legacy': vxProbe,
      },
      historicalDepth: {
        'balance-sheets': bsDepth,
        'income-statements': isDepth,
      },
      fieldMappingHints,
      notes,
    };

    log.info('probe_done', {
      ticker,
      periodEnd,
      bsStatus: bsProbe.status,
      isStatus: isProbe.status,
      cfStatus: cfProbe.status,
      vxStatus: vxProbe.status,
      bsOldest: bsDepth.oldestPeriodEnd,
    });
    return json(200, body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('probe_failed', { ticker, periodEnd, error: msg });
    return json(500, { ok: false, error: msg });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body, null, 2),
  };
}
