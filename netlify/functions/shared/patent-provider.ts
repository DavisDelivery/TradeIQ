// Patent activity provider — Quiver-backed.
//
// Quiver's patents dataset covers USPTO grants mapped directly to public
// tickers (no company-name fuzzy matching needed), which is a meaningful
// upgrade over querying PatentsView by assignee organization name.
//
// What matters in patent signals:
//   - Grant velocity (patents per quarter, trending up) signals an R&D engine
//     actively producing novel IP. A jump from 5 to 40 grants/year = new
//     product line coming to market.
//   - Category matters. Patents in AI, biotech, quantum, defense-tech tend
//     to be worth more than utility bolt-ons. Quiver doesn't always expose
//     CPC, so we fall back to title keyword matching when missing.
//   - Grants lag filings by 18-24 months, so today's grant burst often
//     maps to revenue that shows up 12-24 months from now — this is a
//     forward-looking fundamental, not a price-moving announcement.

import { quiverGetTicker, q, qn, qdate } from './quiver-client';
import { QuiverPatentArraySchema } from './schemas';

export interface PatentGrant {
  patentId: string;
  title: string;
  grantDate: string;
  cpcGroups: string[];
  assignees: string[];
}

export interface PatentActivity {
  ticker: string;
  companyName: string;
  lookbackDays: number;
  totalGrants: number;
  grantsLast30d: number;
  grantsLast90d: number;
  priorPeriodGrants: number;
  velocityChangePct: number;
  highValueGrants: number;
  topCpcGroups: Array<{ group: string; count: number }>;
  recentGrants: PatentGrant[];
  fetchedAt: string;
}

// CPC prefixes that empirically correlate with higher-value patents —
// G06N = AI/ML, A61K/A61P = pharma, H01L = semis, C07D/C07K = biochem,
// G06F17/18 = ML infrastructure, G16H = health informatics.
const HIGH_VALUE_CPC_PREFIXES = ['G06N', 'A61K', 'A61P', 'H01L', 'C07D', 'C07K', 'G06F17', 'G06F18', 'G16H'];

// When Quiver's data lacks CPC codes, fall back to title keyword matching to
// identify high-value tech areas. This is rougher but still catches the big
// categories.
const HIGH_VALUE_KEYWORDS = [
  /\b(machine learning|neural network|deep learning|artificial intelligence|\bai\b)\b/i,
  /\b(semiconductor|wafer|transistor|photolithograph)\b/i,
  /\b(biologic|antibod|monoclonal|vaccine|mrna|crispr|gene therap)\b/i,
  /\b(quantum|superconduct)\b/i,
  /\b(autonomous|lidar|radar array)\b/i,
];

/**
 * Compute patent activity for `ticker`. Lookback windows anchored to
 * "now" by default; `asOfDate` anchors them historically.
 *
 * PIT cutoff: USPTO grant date (`Date` field on Quiver patent rows).
 * Grant date is when the patent became public, so this is a clean PIT
 * filter — no disclosure-lag correction needed.
 *
 * PIT-cacheable: keyed by (ticker, lookbackDays, asOfDate).
 */
export async function getPatentActivity(
  ticker: string,
  companyName: string,
  lookbackDays = 180,
  opts: { asOfDate?: string } = {},
): Promise<PatentActivity> {
  const empty: PatentActivity = {
    ticker, companyName, lookbackDays,
    totalGrants: 0, grantsLast30d: 0, grantsLast90d: 0,
    priorPeriodGrants: 0, velocityChangePct: 0, highValueGrants: 0,
    topCpcGroups: [], recentGrants: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    // Quiver exposes patent data under the `allpatents` endpoint. Some plans
    // also have `patents` — we try both.
    let rows = await quiverGetTicker('allpatents', ticker, { schema: QuiverPatentArraySchema });
    if (rows.length === 0) rows = await quiverGetTicker('patents', ticker, { schema: QuiverPatentArraySchema });
    if (rows.length === 0) return empty;

    const grants = (rows.map(normalizePatent).filter(Boolean) as PatentGrant[])
      // PIT clip: drop anything granted after asOfDate
      .filter((g) => !opts.asOfDate || g.grantDate <= opts.asOfDate);

    const anchorMs = opts.asOfDate
      ? Date.parse(opts.asOfDate + 'T23:59:59Z')
      : Date.now();
    const fromIso = new Date(anchorMs - lookbackDays * 86400000).toISOString().slice(0, 10);
    const priorFromIso = new Date(anchorMs - lookbackDays * 2 * 86400000).toISOString().slice(0, 10);
    const thirtyIso = new Date(anchorMs - 30 * 86400000).toISOString().slice(0, 10);
    const ninetyIso = new Date(anchorMs - 90 * 86400000).toISOString().slice(0, 10);

    const current = grants.filter((g) => g.grantDate >= fromIso);
    const prior = grants.filter((g) => g.grantDate >= priorFromIso && g.grantDate < fromIso);

    const grantsLast30d = current.filter((g) => g.grantDate >= thirtyIso).length;
    const grantsLast90d = current.filter((g) => g.grantDate >= ninetyIso).length;

    const velocityChangePct = prior.length > 0
      ? ((current.length - prior.length) / prior.length) * 100
      : current.length > 0 ? 100 : 0;

    const highValueGrants = current.filter(isHighValue).length;

    const cpcCounts = new Map<string, number>();
    for (const g of current) {
      for (const code of g.cpcGroups) {
        const sub = code.slice(0, 4);
        if (sub) cpcCounts.set(sub, (cpcCounts.get(sub) ?? 0) + 1);
      }
    }
    const topCpcGroups = Array.from(cpcCounts.entries())
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      ticker, companyName, lookbackDays,
      totalGrants: current.length,
      grantsLast30d, grantsLast90d,
      priorPeriodGrants: prior.length,
      velocityChangePct: +velocityChangePct.toFixed(1),
      highValueGrants,
      topCpcGroups,
      recentGrants: current.slice(0, 10),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return empty;
  }
}

function normalizePatent(raw: any): PatentGrant | null {
  if (!raw) return null;
  const patentId = String(q(raw, 'PatentNumber', 'PatentID', 'patent_id', 'id') ?? '');
  const title = String(q(raw, 'Title', 'title', 'patent_title') ?? '').trim();
  const grantDate = qdate(raw, 'Date', 'GrantDate', 'grant_date', 'patent_date');
  if (!patentId || !grantDate) return null;

  const cpcRaw = q(raw, 'CPC', 'cpc', 'CPCGroups', 'cpc_groups');
  const cpcGroups: string[] = Array.isArray(cpcRaw)
    ? cpcRaw.map(String)
    : typeof cpcRaw === 'string' ? cpcRaw.split(/[,\s;]+/).filter(Boolean) : [];

  const assigneeRaw = q(raw, 'Assignee', 'assignee', 'Assignees', 'assignees');
  const assignees: string[] = Array.isArray(assigneeRaw)
    ? assigneeRaw.map(String)
    : assigneeRaw ? [String(assigneeRaw)] : [];

  return { patentId, title, grantDate, cpcGroups, assignees };
}

function isHighValue(g: PatentGrant): boolean {
  if (g.cpcGroups.some((c) => HIGH_VALUE_CPC_PREFIXES.some((p) => c.startsWith(p)))) return true;
  if (g.cpcGroups.length === 0 && g.title) {
    return HIGH_VALUE_KEYWORDS.some((re) => re.test(g.title));
  }
  return false;
}

export function scorePatentActivity(p: PatentActivity): {
  score: number;
  confidence: number;
  rationale: string;
  tags: string[];
} {
  const tags: string[] = [];
  const parts: string[] = [];
  let raw = 0;

  if (p.totalGrants === 0) {
    return { score: 50, confidence: 0.1, rationale: 'no recent patents', tags: [] };
  }

  if (p.totalGrants > 40) { raw += 15; parts.push(`${p.totalGrants} grants in ${p.lookbackDays}d`); }
  else if (p.totalGrants > 10) { raw += 8; parts.push(`${p.totalGrants} grants in ${p.lookbackDays}d`); }
  else if (p.totalGrants > 3) { raw += 3; parts.push(`${p.totalGrants} grants in ${p.lookbackDays}d`); }

  if (p.velocityChangePct > 50) {
    raw += 20;
    tags.push(`+${Math.round(p.velocityChangePct)}% grants`);
    parts.push(`${Math.round(p.velocityChangePct)}% velocity increase`);
  } else if (p.velocityChangePct > 20) {
    raw += 10;
    tags.push(`+${Math.round(p.velocityChangePct)}% grants`);
    parts.push(`${Math.round(p.velocityChangePct)}% velocity increase`);
  } else if (p.velocityChangePct < -30) {
    raw -= 5;
    parts.push('declining patent output');
  }

  const hvShare = p.totalGrants > 0 ? p.highValueGrants / p.totalGrants : 0;
  if (hvShare > 0.3 && p.highValueGrants >= 3) {
    raw += 15;
    tags.push(`${p.highValueGrants} high-value`);
    parts.push(`${p.highValueGrants} patents in AI/bio/semi codes`);
  }

  if (p.grantsLast30d >= 5) {
    raw += 8;
    tags.push(`${p.grantsLast30d} in 30d`);
  }

  raw = Math.max(-20, Math.min(50, raw));
  const score = Math.round(50 + raw);
  const confidence = Math.min(1, p.totalGrants / 20);

  return {
    score,
    confidence,
    rationale: parts.join(', ') || 'steady patent output',
    tags,
  };
}
