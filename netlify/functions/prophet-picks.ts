// GET /api/prophet-picks
//   ?universe=conservative|aggressive|everything (default conservative)
//   &minConviction=low|medium|high
//   &limit=30
//   &narrate=1|0 (default 1 — include Claude narrative for top 10)
//
// PROPHET: Probability-Ranked Opportunity Picker using Heuristic Ensemble Trading.
// 7-layer ensemble: structure, momentum, volume, volatility, RS, fundamentals, catalyst.
// Aggressive mode scans S&P500 + NDX + Dow + Russell2K (deduped).

import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, SECTOR_ETFS, SPY, findEntry } from './shared/universe';
import { getDailyBars, getFundamentals, getUpcomingEarnings } from './shared/data-provider';
import { getInsiderActivity } from './shared/insider-provider';
import { getPoliticalActivity } from './shared/political-provider';
import { getGovContractActivity } from './shared/govcontracts-provider';
import { getPatentActivity } from './shared/patent-provider';
import { computeRegime } from './shared/regime';
import {
  layerStructure, layerMomentum, layerVolume, layerVolatility,
  layerRelativeStrength, layerFundamental, layerCatalyst,
  composeProphet, type ProphetScore, type FundInput, type CatalystInput,
} from './shared/prophet-layers';
import type { Bar } from './shared/data-provider';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const headers = { 'Content-Type': 'application/json' };
const json = (code: number, body: unknown) => ({
  statusCode: code,
  headers,
  body: JSON.stringify(body),
});

// Module-level cache. Aggressive scans reuse this across invocations (in warm containers)
// to avoid re-scanning 2,500 tickers on every request. Cold start = fresh scan.
interface ProphetPick extends ProphetScore {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  priceChangePct: number;
  narrative?: string;
}

const resultCache = new Map<string, { picks: ProphetPick[]; generatedAt: string; universeSize: number }>();
const CACHE_TTL_MS = 20 * 60 * 1000;  // 20 min for full scan results

// Narrative cache, keyed by ticker+composite-band, TTL 6 hours
const narrativeCache = new Map<string, { text: string; at: number }>();
const NARRATIVE_TTL_MS = 6 * 60 * 60 * 1000;

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const universe = (qs.universe as 'conservative' | 'aggressive' | 'everything') ?? 'conservative';
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
      generatedAt: cached.generatedAt,
      picks: filterByConviction(cached.picks, minConviction).slice(0, limit),
    });
  }

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
    for (const [sector, etf] of Object.entries(SECTOR_ETFS)) {
      try { sectorEtfCache[sector] = await getDailyBars(etf, from, to); }
      catch { sectorEtfCache[sector] = []; }
    }
    // Compute sector rank (20d return)
    const sectorRank: Record<string, number> = {};
    const sectorReturns = Object.entries(sectorEtfCache).map(([sector, bars]) => {
      if (bars.length < 21) return { sector, ret: 0 };
      const ret = (bars[bars.length - 1].c - bars[bars.length - 21].c) / bars[bars.length - 21].c;
      return { sector, ret };
    }).sort((a, b) => b.ret - a.ret);
    sectorReturns.forEach((s, i) => { sectorRank[s.sector] = i + 1; });

    const picks: ProphetPick[] = [];
    const concurrency = 8;

    for (let i = 0; i < scanUniverse.length; i += concurrency) {
      const chunk = scanUniverse.slice(i, i + concurrency);
      const batch = await Promise.all(chunk.map((entry) => scoreTicker(
        entry, from, to, spyBars, sectorEtfCache[entry.sector] ?? null,
        sectorRank[entry.sector] ?? 6, macroBias,
      ).catch((err) => {
        console.error(`[prophet] ${entry.ticker}`, err.message);
        return null;
      })));
      for (const p of batch) if (p && p.conviction) picks.push(p);
    }

    // Sort by composite desc
    picks.sort((a, b) => b.composite - a.composite);

    // Narrative for top N
    if (narrate && process.env.ANTHROPIC_API_KEY) {
      const narratives = Math.min(10, picks.length);
      for (let i = 0; i < narratives; i++) {
        const text = await getCachedNarrative(picks[i]);
        if (text) picks[i].narrative = text;
      }
    }

    const generatedAt = new Date().toISOString();
    resultCache.set(cacheKey, { picks, generatedAt, universeSize: scanUniverse.length });

    return json(200, {
      ok: true,
      cached: false,
      universe,
      universeSize: scanUniverse.length,
      qualified: picks.length,
      regime,
      generatedAt,
      picks: filterByConviction(picks, minConviction).slice(0, limit),
    });
  } catch (err: any) {
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

function pickUniverse(mode: 'conservative' | 'aggressive' | 'everything') {
  if (mode === 'conservative') {
    // S&P 500 + NDX deduped
    const sp = inIndex('sp500');
    const nd = inIndex('ndx');
    const seen = new Set<string>();
    return [...sp, ...nd].filter((u) => {
      if (seen.has(u.ticker)) return false;
      seen.add(u.ticker);
      return true;
    });
  }
  if (mode === 'aggressive') {
    return UNIVERSE;  // all 399 tickers in our ROWS table (sp500+ndx+dow+russell2k deduped already)
  }
  // 'everything' — same as aggressive for now (no more universe tiers defined)
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
  const [bars, fund, earnings, insider, political, contracts, patents] = await Promise.all([
    getDailyBars(entry.ticker, from, to),
    getFundamentals(entry.ticker).catch(() => null),
    getUpcomingEarnings(entry.ticker, 30).catch(() => null),
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
  };

  const daysUntilEarnings = earnings?.date
    ? Math.round((new Date(earnings.date).getTime() - Date.now()) / 86400000)
    : null;

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

    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 350,
        temperature: 0.25,
        system: 'You are a veteran swing trader writing a concise thesis. Be specific with price levels. No boilerplate, no "DYOR", no disclaimers.',
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content.find((b) => b.type === 'text')?.text?.trim() ?? null;
  } catch {
    return null;
  }
}
