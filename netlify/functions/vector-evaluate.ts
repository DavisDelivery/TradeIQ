// VECTOR — live ticker evaluator.
//
// GET /api/vector-evaluate?ticker=NVDA
//
// Works on ANY hygiene-passing symbol, event or not: live F/T verdict with
// sub-scores, the quadrant, active/recent events from the library, and
// _noData flags surfaced — a null pillar is SHOWN as unresolved, never
// silently scored (design: "unresolved => null + _noData, never silently").
//
// F-axis inputs resolved live:
//   latestSue / consecutive SUE — Massive PIT income statements (as-reported
//     diluted EPS), SUE per the frozen formula.
//   insiderNet90d / sellCluster — Finnhub Form 4, trailing 90d.
//   fscore — null + _noData (Piotroski module is a named follow-up; the
//     F axis computes from the rest per design).
//   instDelta — vector_13f_agg when the ticker's quarters are aggregated,
//     else null + _noData.
// T-axis inputs from live bars + the macro regime (risk_on -> offense;
// risk_off maps to panic only at VIX > 28, else caution).

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { getIncomeStatementsPit } from './shared/massive-fundamentals';
import { getFinnhubInsiderTransactionsWithStatus } from './shared/data-provider';
import { computeRegime } from './shared/regime';
import { computeFeatures, type FBar } from './shared/vector-features';
import { computeSue, sellClusterActive, type InsiderTx } from './shared/vector-events';
import { scoreFAxis, scoreTAxis } from './shared/vector-verdict';
import { quadrantOf, HYGIENE, sizeBucketOf, VECTOR_MODEL_VERSION } from './shared/vector-constants';
import { VECTOR_COLLECTIONS } from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'vector-evaluate' });

const cache = new Map<string, { data: any; at: number }>();
const TTL_MS = 10 * 60_000;

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  if (!ticker || !/^[A-Z.\-]{1,8}$/.test(ticker)) {
    return json(400, { ok: false, error: 'ticker required' });
  }
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < TTL_MS) return json(200, { ...hit.data, cached: true });

  const start = Date.now();
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 900 * 86_400_000).toISOString().slice(0, 10);
    const [bars, spy] = await Promise.all([
      getDailyBars(ticker, from, to) as unknown as Promise<FBar[]>,
      getDailyBars('SPY', from, to) as unknown as Promise<FBar[]>,
    ]);

    // Hygiene at t = today.
    if (!bars.length) return json(200, { ok: false, ticker, error: `no price data for ${ticker}` });
    const close = bars[bars.length - 1].c;
    const window63 = bars.slice(-63);
    const medDv = window63.length === 63
      ? [...window63.map((b) => b.c * b.v)].sort((a, b) => a - b)[31]
      : null;
    const hygiene = {
      pass: close >= HYGIENE.minClose && bars.length >= HYGIENE.minBars && (medDv ?? 0) >= HYGIENE.minMedianDollarVol63d,
      close,
      bars: bars.length,
      medianDollarVol63d: medDv != null ? Math.round(medDv) : null,
      sizeBucket: medDv != null ? sizeBucketOf(medDv) : null,
    };
    if (!hygiene.pass) {
      const out = { ok: true, ticker, hygiene, note: 'fails universe hygiene — no verdict issued', modelVersion: VECTOR_MODEL_VERSION };
      cache.set(ticker, { data: out, at: Date.now() });
      return json(200, out);
    }

    const features = computeFeatures(bars, spy);

    // ---- F inputs, fetched IN PARALLEL with per-dependency time caps ----
    // The serial version stacked Massive + Finnhub (patient ~50s retry
    // path) + FRED past the function timeout and died with NO response —
    // the UI spun on "evaluating…" forever. A dependency that can't answer
    // inside its cap resolves null -> _noData; the verdict ships without
    // it rather than not shipping at all.
    const capped = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);

    const [stmtsRes, insRes, regimeRes] = await Promise.all([
      capped(getIncomeStatementsPit(ticker, to, 48), 8000),
      capped(getFinnhubInsiderTransactionsWithStatus(ticker, 100, {}), 8000),
      capped(computeRegime(), 6000),
    ]);

    let latestSue: number | null = null;
    let consecutivePositiveSue = 0;
    if (stmtsRes) {
      const eps = (stmtsRes as any[])
        .filter((s: any) => s.diluted_earnings_per_share != null && s.period_end)
        .sort((a: any, b: any) => String(a.period_end).localeCompare(String(b.period_end)))
        .map((s: any) => s.diluted_earnings_per_share as number);
      if (eps.length >= HYGIENE.minEpsQuarters) {
        latestSue = computeSue(eps);
        for (let k = 0; k < 8; k++) {
          const s = computeSue(eps.slice(0, eps.length - k));
          if (s != null && s > 0) consecutivePositiveSue++;
          else break;
        }
      }
    }

    let insiderNet90d: number | null = null;
    let sellCluster = false;
    if (insRes) {
      const raw = ((insRes as any)?.data ?? []) as any[];
      const txs: InsiderTx[] = raw
        .filter((r) => (r.transactionCode === 'P' || r.transactionCode === 'S') && r.transactionPrice > 0)
        .map((r) => ({
          insiderName: String(r.name ?? 'unknown'),
          code: r.transactionCode,
          transactionDate: String(r.transactionDate ?? ''),
          filingDate: String(r.filingDate ?? r.transactionDate ?? ''),
          dollars: Math.abs((r.change ?? r.share ?? 0) * (r.transactionPrice ?? 0)),
          isOfficerOrDirector: true,
        }));
      if (raw.length || (insRes as any)?.ok !== false) {
        insiderNet90d = Math.round(
          txs.reduce((a, t) => a + (t.code === 'P' ? t.dollars : -t.dollars), 0),
        );
        sellCluster = sellClusterActive(txs.filter((t) => t.code === 'S'), to);
      }
    }

    let instDelta: number | null = null; // wired once 13F agg covers current quarters

    let regime: 'offense' | 'neutral' | 'caution' | 'panic' | null = null;
    if (regimeRes) {
      const r = regimeRes as Awaited<ReturnType<typeof computeRegime>>;
      regime = r.regime === 'risk_on' ? 'offense'
        : r.regime === 'risk_off' ? ((r.vol?.level ?? 0) > 28 ? 'panic' : 'caution')
        : 'neutral';
    }

    const f = scoreFAxis({ fscore: null, latestSue, consecutivePositiveSue, insiderNet90d, sellCluster, instDelta });
    const t = scoreTAxis({
      close: features.close,
      sma50: features.sma50,
      sma200: features.sma200,
      extension: features.extension,
      contraction: features.contraction,
      regime,
      drawdown: features.drawdown,
      ema20: features.ema20,
      higherFiveDayLow: features.higherFiveDayLow,
    });

    // Recent events for this ticker from the library.
    // Composite-index-free: equality-only query, sort + trim in memory.
    const evSnap = await getAdminDb().collection(VECTOR_COLLECTIONS.events)
      .where('ticker', '==', ticker).limit(60).get();
    const events = evSnap.docs.sort((a, b) =>
      String((b.data() as any).date).localeCompare(String((a.data() as any).date)),
    ).slice(0, 10).map((d) => {
      const e = d.data() as any;
      return { id: d.id, type: e.type, date: e.date, payload: e.payload, sizeBucket: e.sizeBucket, agreement: e.agreement ?? null };
    });

    const out = {
      ok: true,
      ticker,
      hygiene,
      f,
      t,
      quadrant: quadrantOf(f.verdict, t.verdict),
      regime,
      features,
      events,
      modelVersion: VECTOR_MODEL_VERSION,
      generatedAt: new Date().toISOString(),
    };
    cache.set(ticker, { data: out, at: Date.now() });
    log.info('evaluated', { ticker, quadrant: out.quadrant, durationMs: Date.now() - start });
    return json(200, out);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('evaluate_failed', { ticker, err: msg });
    return json(500, { ok: false, ticker, error: msg });
  }
};
