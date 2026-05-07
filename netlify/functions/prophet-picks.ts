// GET /api/prophet-picks
//   ?universe=largecap|russell|all (default largecap)
//       largecap = S&P 500 + NDX + Dow deduped (~230 tickers)
//       russell  = Russell 2000 only (~168 tickers)
//       all      = all four indices combined (~399 tickers)
//   &minConviction=low|medium|high
//   &limit=30
//   &narrate=1|0 (default 1 — include Claude narrative for top 10)
//
// PROPHET: Probability-Ranked Opportunity Picker using Heuristic Ensemble Trading.
// 7-layer ensemble: structure, momentum, volume, volatility, RS, fundamentals, catalyst.
// Enforces a soft time budget (~22s) and returns partial results rather than timing out.

import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, SECTOR_ETFS, SPY, findEntry } from './shared/universe';
import { getDailyBars, getFundamentals, getUpcomingEarnings } from './shared/data-provider';
import { getEarningsIntel } from './shared/earnings-intel';
import { getInsiderActivity } from './shared/insider-provider';
import { getPoliticalActivity } from './shared/political-provider';
import { getGovContractActivity } from './shared/govcontracts-provider';
import { callAnthropic, BudgetExhaustedError, CircuitOpenError } from './shared/anthropic-client';
import { getPatentActivity } from './shared/patent-provider';
import { computeRegime } from './shared/regime';
import {
  layerStructure, layerMomentum, layerVolume, layerVolatility,
  layerRelativeStrength, layerFundamental, layerCatalyst,
  composeProphet, type ProphetScore, type FundInput, type CatalystInput,
} from './shared/prophet-layers';
import type { Bar } from './shared/data-provider';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-7';

// Hard time budget for the scan loop. Netlify function timeout is 26s; we need
// buffer for response serialization + narrative calls on top.
const SCAN_BUDGET_MS = 18_000;
const NARRATIVE_BUDGET_MS = 3_000;

const headers = { 'Content-Type': 'application/json; charset=utf-8' };
const json = (code: number, body: unknown) => ({
  statusCode: code,
  headers,
  body: JSON.stringify(body),
});

interface ProphetPick extends ProphetScore {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  priceChangePct: number;
  narrative?: string;
  earnings?: {
    epsGrowthYoY?: number;
    revenueGrowthYoY?: number;
    epsAcceleration?: number;
    beatsLast4?: number;
    avgSurpriseMagnitude?: number;
    streak?: 'beats' | 'misses' | 'mixed';
    nextEarningsDate?: string;
    daysUntilEarnings?: number;
    postEarningsDrift?: boolean;
  };
}

// Module-level cache. Aggressive scans reuse this across invocations (in warm containers)
// to avoid re-scanning on every request. Persists while Lambda container is warm.
const resultCache = new Map<string, { picks: ProphetPick[]; generatedAt: string; universeSize: number; partial: boolean }>();
const CACHE_TTL_MS = 20 * 60 * 1000;  // 20 min for full scan results
// When a live scan fails or times out, fall back to stale cache as old as this:
const STALE_CACHE_TTL_MS = 4 * 60 * 60 * 1000;  // 4 hours

// Narrative cache, keyed by ticker+composite-band, TTL 6 hours
const narrativeCache = new Map<string, { text: string; at: number }>();
const NARRATIVE_TTL_MS = 6 * 60 * 60 * 1000;

// Test-only export: exposes the module-scoped cache so the cache-poisoning
// regression suite can assert empty results never poison the cache.
export const __testInternals = {
  resultCache,
  narrativeCache,
  reset: () => { resultCache.clear(); narrativeCache.clear(); },
};

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const universe = (qs.universe as 'largecap' | 'russell' | 'all') ?? 'largecap';
  const minConviction = (qs.minConviction as 'low' | 'medium' | 'high') ?? 'low';
  const limit = Math.min(Number(qs.limit ?? 30), 100);
  const narrate = qs.narrate !== '0';

  const scanUniverse = pickUniverse(universe);
  const cacheKey = `${universe}:${minConviction}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS) {
    return json(200, {
      ok: true,
      cached: true,
      universe,
      universeSize: cached.universeSize,
      partial: cached.partial,
      generatedAt: cached.generatedAt,
      picks: filterByConviction(cached.picks, minConviction).slice(0, limit),
    });
  }

  const scanStart = Date.now();
  try {
    // Pre-fetch shared context
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 300 * 86400000).toISOString().slice(0, 10);
    const [spyBars, regime] = await Promise.all([
      getDailyBars(SPY, from, to),
      computeRegime().catch(() => null),
    ]);
    const macroBias = regime?.regime === 'risk_on' ? 0.5 : regime?.regime === 'risk_off' ? -0.5 : 0;

    // Sector ETF cache
    const sectorEtfCache: Record<string, Bar[]> = {};
    await Promise.all(Object.entries(SECTOR_ETFS).map(async ([sector, etf]) => {
      try { sectorEtfCache[sector] = await getDailyBars(etf, from, to); }
      catch { sectorEtfCache[sector] = []; }
    }));

    // Compute sector rank (20d return)
    const sectorRank: Record<string, number> = {};
    const sectorReturns = Object.entries(sectorEtfCache).map(([sector, bars]) => {
      if (bars.length < 21) return { sector, ret: 0 };
      const ret = (bars[bars.length - 1].c - bars[bars.length - 21].c) / bars[bars.length - 21].c;
      return { sector, ret };
    }).sort((a, b) => b.ret - a.ret);
    sectorReturns.forEach((s, i) => { sectorRank[s.sector] = i + 1; });

    const picks: ProphetPick[] = [];
    // Concurrency 7 — sweet spot. At 5 we don't saturate; at 10+ we get DNS cache
    // overflow on Netlify (each ticker fires ~7 concurrent HTTPS calls = 70 sockets).
    const concurrency = 7;
    let tickersScanned = 0;
    let partial = false;

    // Sufficient-qualified early stop: once we have 3x the limit of qualified picks
    // we can stop scanning — the top `limit` by composite score are unlikely to change.
    const sufficientQualified = limit * 3;

    for (let i = 0; i < scanUniverse.length; i += concurrency) {
      // Time budget check — preserve time for response + narratives
      const elapsed = Date.now() - scanStart;
      if (elapsed > SCAN_BUDGET_MS) {
        console.log(`[prophet] time budget exhausted at ${tickersScanned}/${scanUniverse.length}`);
        partial = true;
        break;
      }
      if (picks.length >= sufficientQualified) {
        console.log(`[prophet] early stop: ${picks.length} qualified at ${tickersScanned} scanned`);
        break;
      }

      const chunk = scanUniverse.slice(i, i + concurrency);
      const batch = await Promise.all(chunk.map((entry) => scoreTicker(
        entry, from, to, spyBars, sectorEtfCache[entry.sector] ?? null,
        sectorRank[entry.sector] ?? 6, macroBias,
      ).catch((err) => {
        console.error(`[prophet] ${entry.ticker}`, err.message);
        return null;
      })));
      tickersScanned += chunk.length;
      for (const p of batch) if (p && p.conviction) picks.push(p);
    }

    // Sort by composite desc
    picks.sort((a, b) => b.composite - a.composite);

    // Narrative for top N within remaining time budget.
    // Cap at 5 — more than that bloats response size past 250KB which
    // can trigger mid-response truncation on mobile clients.
    if (narrate && process.env.ANTHROPIC_API_KEY) {
      const narrativeStart = Date.now();
      const maxNarratives = Math.min(5, picks.length);
      for (let i = 0; i < maxNarratives; i++) {
        if (Date.now() - narrativeStart > NARRATIVE_BUDGET_MS) break;
        const text = await getCachedNarrative(picks[i]);
        if (text) picks[i].narrative = sanitizeForJson(text);
      }
    }

    const generatedAt = new Date().toISOString();
    // Only cache successful scans — caching empty results poisons subsequent
    // requests for the full TTL (20 min), locking users into 0 picks even after
    // the cold-start penalty clears.
    if (picks.length > 0) {
      resultCache.set(cacheKey, { picks, generatedAt, universeSize: scanUniverse.length, partial });
    }

    return json(200, {
      ok: true,
      cached: false,
      universe,
      universeSize: scanUniverse.length,
      tickersScanned,
      qualified: picks.length,
      partial,
      regime,
      generatedAt,
      picks: filterByConviction(picks, minConviction).slice(0, limit),
    });
  } catch (err: any) {
    // On error, fall back to stale cache if we have one
    const stale = resultCache.get(cacheKey);
    if (stale && Date.now() - new Date(stale.generatedAt).getTime() < STALE_CACHE_TTL_MS) {
      return json(200, {
        ok: true,
        cached: true,
        stale: true,
        universe,
        universeSize: stale.universeSize,
        partial: stale.partial,
        generatedAt: stale.generatedAt,
        picks: filterByConviction(stale.picks, minConviction).slice(0, limit),
        warning: `Live scan failed (${err?.message ?? err}); returning last successful scan.`,
      });
    }
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

// Strip control characters, fold smart punctuation to ASCII so the response
// is safe to parse regardless of client-side charset handling (iOS Safari is
// particularly strict with unicode in JSON when Content-Type lacks an explicit
// charset declaration).
function sanitizeForJson(s: string): string {
  return s
    // Remove all ASCII control chars except newline/tab
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Fold em-dash and en-dash to ASCII hyphen
    .replace(/[\u2013\u2014\u2015]/g, '-')
    // Fold smart single quotes to apostrophe
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Fold smart double quotes to straight quote
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Fold ellipsis to three dots
    .replace(/\u2026/g, '...')
    // Remove U+2028 and U+2029 line/paragraph separators
    .replace(/[\u2028\u2029]/g, ' ')
    // Cap length
    .slice(0, 1500)
    .trim();
}

function pickUniverse(mode: 'largecap' | 'russell' | 'all') {
  if (mode === 'largecap') {
    // S&P 500 + NDX + Dow deduped
    const seen = new Set<string>();
    return [...inIndex('sp500'), ...inIndex('ndx'), ...inIndex('dow')].filter((u) => {
      if (seen.has(u.ticker)) return false;
      seen.add(u.ticker);
      return true;
    });
  }
  if (mode === 'russell') {
    return inIndex('russell2k');
  }
  // 'all' — all four indices deduped (already deduped in UNIVERSE.ts ROWS)
  return UNIVERSE;
}

function filterByConviction(picks: ProphetPick[], min: 'low' | 'medium' | 'high') {
  if (min === 'high') return picks.filter((p) => p.conviction === 'HIGH');
  if (min === 'medium') return picks.filter((p) => p.conviction === 'HIGH' || p.conviction === 'MEDIUM');
  return picks.filter((p) => p.conviction !== null);
}

async function scoreTicker(
  entry: { ticker: string; name: string; sector: string },
  from: string, to: string,
  spyBars: Bar[],
  sectorBars: Bar[] | null,
  sectorRank: number,
  macroBias: number,
): Promise<ProphetPick | null> {
  const [bars, fund, intel, insider, political, contracts, patents] = await Promise.all([
    getDailyBars(entry.ticker, from, to),
    getFundamentals(entry.ticker).catch(() => null),
    getEarningsIntel(entry.ticker).catch(() => null),
    getInsiderActivity(entry.ticker, 90).catch(() => null),
    getPoliticalActivity(entry.ticker, 180).catch(() => null),
    getGovContractActivity(entry.ticker, 180).catch(() => null),
    getPatentActivity(entry.ticker, entry.name, 180).catch(() => null),
  ]);

  if (bars.length < 200) return null;

  // Compute PE proxy for fundamentals layer
  const latestBar = bars[bars.length - 1];
  const pe = fund?.ttmEps && fund.ttmEps > 0 ? latestBar.c / fund.ttmEps : undefined;
  const peg = pe !== undefined && fund?.epsGrowthYoY && fund.epsGrowthYoY > 0
    ? pe / (fund.epsGrowthYoY * 100) : undefined;

  const fundInput: FundInput = {
    revenueGrowthYoY: fund?.revenueGrowthYoY,
    epsGrowthYoY: fund?.epsGrowthYoY,
    operatingMargin: fund?.operatingMargin,
    grossMargin: fund?.grossMargin,
    pe, peg,
    // NEW: pass earnings intel into fundamental layer
    epsSurpriseBeats: intel?.beatsLast4,
    epsAcceleration: intel?.epsAcceleration,
    avgSurpriseMagnitude: intel?.avgSurpriseMagnitude,
    postEarningsDrift: intel?.postEarningsDrift,
    streak: intel?.streak,
  };

  const daysUntilEarnings = intel?.daysUntilEarnings ?? null;

  const catInput: CatalystInput = {
    insiderScore: insider ? scoreInsider(insider) : undefined,
    insiderCluster: !!(insider && insider.clusters.length > 0),
    cSuiteBuy: !!insider?.transactions.some((t) => /CEO|CFO|CHIEF|PRESIDENT|CHAIR/i.test(t.position)),
    firstBuyInYear: insider?.firstBuyInAYear,
    politicalScore: political ? scorePolitical(political) : undefined,
    bipartisanPolitical: political?.bipartisan ?? false,
    govContractScore: contracts ? scoreContracts(contracts) : undefined,
    patentScore: patents ? scorePatents(patents) : undefined,
    patentVelocity: patents ? (patents.velocityChangePct / 100) : undefined,
    daysUntilEarnings,
    postEarningsDrift: intel?.postEarningsDrift,  // NEW
    macroBias,
    sectorRank,
  };

  const layers = {
    structure: layerStructure(bars),
    momentum: layerMomentum(bars),
    volume: layerVolume(bars),
    volatility: layerVolatility(bars),
    relativeStrength: layerRelativeStrength(bars, spyBars, sectorBars),
    fundamental: layerFundamental(fundInput),
    catalyst: layerCatalyst(catInput),
  };

  const composed = composeProphet(bars, layers, macroBias);
  const prevBar = bars[bars.length - 2];
  const priceChangePct = prevBar ? +((latestBar.c - prevBar.c) / prevBar.c * 100).toFixed(2) : 0;

  return {
    ticker: entry.ticker,
    name: entry.name,
    sector: entry.sector,
    price: latestBar.c,
    priceChangePct,
    layers,
    ...composed,
    earnings: intel ? {
      epsGrowthYoY: intel.epsGrowthYoY,
      revenueGrowthYoY: intel.revenueGrowthYoY,
      epsAcceleration: intel.epsAcceleration,
      beatsLast4: intel.beatsLast4,
      avgSurpriseMagnitude: intel.avgSurpriseMagnitude,
      streak: intel.streak,
      nextEarningsDate: intel.nextEarningsDate,
      daysUntilEarnings: intel.daysUntilEarnings,
      postEarningsDrift: intel.postEarningsDrift,
    } : undefined,
  };
}

function scoreInsider(a: any): number {
  if (a.totalBuys === 0 && a.totalSells === 0) return 50;
  let raw = 0;
  if (a.clusters.length > 0) {
    const biggest = a.clusters.reduce((x: any, y: any) => y.buyerCount > x.buyerCount ? y : x);
    raw += Math.min(40, biggest.buyerCount * 10);
  }
  if (a.netDollars > 5_000_000) raw += 20;
  else if (a.netDollars > 1_000_000) raw += 12;
  else if (a.netDollars < -5_000_000) raw -= 10;
  if (a.firstBuyInAYear) raw += 15;
  return Math.max(0, Math.min(100, 50 + Math.max(-50, Math.min(50, raw))));
}

function scorePolitical(p: any): number {
  const net = p.netTrades ?? 0;
  const lobbyChange = (p.lobbyingVelocityPct ?? 0) / 100;
  let raw = net * 5 + (p.bipartisan ? 15 : 0) + (lobbyChange > 0.2 ? 10 : 0);
  return Math.max(0, Math.min(100, 50 + Math.max(-30, Math.min(40, raw))));
}

function scoreContracts(c: any): number {
  const total = c.totalDollars ?? 0;
  const diversity = c.topAgencies?.length ?? 0;
  let raw = 0;
  if (total > 100_000_000) raw += 30;
  else if (total > 10_000_000) raw += 18;
  else if (total > 1_000_000) raw += 8;
  if (diversity >= 3) raw += 10;
  return Math.max(0, Math.min(100, 50 + raw));
}

function scorePatents(p: any): number {
  const velocity = p.velocityChange ?? 0;
  let raw = 0;
  if (velocity > 0.5) raw += 25;
  else if (velocity > 0.2) raw += 12;
  else if (velocity < -0.3) raw -= 10;
  if ((p.highValueGrants ?? 0) > 0) raw += 10;
  return Math.max(0, Math.min(100, 50 + raw));
}

async function getCachedNarrative(pick: ProphetPick): Promise<string | null> {
  const band = Math.floor(pick.composite / 5) * 5;
  const key = `${pick.ticker}:${band}`;
  const hit = narrativeCache.get(key);
  if (hit && Date.now() - hit.at < NARRATIVE_TTL_MS) return hit.text;

  const text = await generateNarrative(pick);
  if (text) narrativeCache.set(key, { text, at: Date.now() });
  return text;
}

async function generateNarrative(pick: ProphetPick): Promise<string | null> {
  try {
    const layerLines = Object.entries(pick.layers).map(([name, r]) =>
      `${name}: score ${r.score} ${r.pass ? '✓' : '✗'} — ${Object.entries(r.details).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', ')}`
    ).join('\n');
    const user = `Ticker: ${pick.ticker} (${pick.name}, ${pick.sector})
Price: $${pick.price.toFixed(2)} (${pick.priceChangePct >= 0 ? '+' : ''}${pick.priceChangePct}%)
PROPHET composite: ${pick.composite}/100 · conviction ${pick.conviction} · ${pick.layersPassed}/7 layers pass
Flags: ${pick.flags.join(', ')}
Entry: $${pick.entry} · Stop: $${pick.stop} · Targets: ${pick.targets.join(', ')} · Invalidation: $${pick.invalidation}

Layer breakdown:
${layerLines}

Write a 3-4 sentence trader's read: what the chart + catalysts + fundamentals together are saying, and one specific invalidation condition. Reference actual price levels. No disclaimers.`;

    try {
      const data = await callAnthropic({
        model: MODEL,
        max_tokens: 350,
        temperature: 0.25,
        system: 'You are a veteran swing trader writing a concise thesis. Be specific with price levels. No boilerplate, no "DYOR", no disclaimers.',
        messages: [{ role: 'user', content: user }],
      });
      return data.content.find((b) => b.type === 'text')?.text?.trim() ?? null;
    } catch (err) {
      // Narratives are best-effort — if budget/circuit/upstream fail,
      // we drop the narrative rather than failing the whole prophet response.
      if (err instanceof BudgetExhaustedError || err instanceof CircuitOpenError) {
        return null;
      }
      return null;
    }
  } catch {
    return null;
  }
}
