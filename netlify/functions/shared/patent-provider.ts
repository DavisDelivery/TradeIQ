// Patent activity provider.
//
// Pulls recent patent grants from the USPTO PatentsView API, keyed by
// assignee organization name. This is useful because:
//
//   - Patent grants are PUBLIC and usually underappreciated by the market.
//     A meaningful patent grant often doesn't move the stock on day 1 but
//     shows up in revenue 12-24 months later when the product ships.
//   - Grant velocity (patents per quarter, trending up) signals an R&D
//     engine that's actively producing novel IP.
//   - Category matters: patents in AI, quantum, biotech, and defense-tech
//     CPC codes are usually worth more per patent than utility bolt-ons.
//   - Citation activity (how many OTHER patents cite this one) is the best
//     single proxy for patent importance, but it lags 2-3 years. We don't
//     use it for freshly-granted patents.
//
// Requires PATENTSVIEW_API_KEY (free at patentsview.org). If the key is not
// set or the API fails, we return an empty result and downstream scoring
// degrades gracefully to neutral — the app still works, the signal just
// disappears for that ticker.

const PATENTSVIEW = 'https://search.patentsview.org/api/v1';

// CPC classifications that tend to correlate with higher-value patents.
// G06N = AI/machine learning, G06F = software/computing, H04L = networking,
// A61* = medical/pharma, H01L = semiconductors, C07 = biochem, G06Q = business
// methods (watch out — lots of junk here too).
const HIGH_VALUE_CPC_PREFIXES = ['G06N', 'A61K', 'A61P', 'H01L', 'C07D', 'C07K', 'G06F17', 'G06F18', 'G16H'];

export interface PatentGrant {
  patentId: string;
  title: string;
  grantDate: string;
  cpcGroups: string[];   // e.g., ["G06N3/08", "G06F17/16"]
  assignees: string[];
}

export interface PatentActivity {
  ticker: string;
  companyName: string;
  lookbackDays: number;
  totalGrants: number;
  grantsLast30d: number;
  grantsLast90d: number;
  priorPeriodGrants: number;   // same-length period before lookback — for velocity delta
  velocityChangePct: number;   // (recent - prior) / prior * 100
  highValueGrants: number;     // count of grants in HIGH_VALUE_CPC_PREFIXES
  topCpcGroups: Array<{ group: string; count: number }>;
  recentGrants: PatentGrant[]; // most recent 10
  fetchedAt: string;
}

const cache = new Map<string, { data: PatentActivity; at: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — patents don't move fast

export async function getPatentActivity(
  ticker: string,
  companyName: string,
  lookbackDays = 180,
): Promise<PatentActivity> {
  const cacheKey = `${ticker}:${lookbackDays}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const empty: PatentActivity = {
    ticker,
    companyName,
    lookbackDays,
    totalGrants: 0,
    grantsLast30d: 0,
    grantsLast90d: 0,
    priorPeriodGrants: 0,
    velocityChangePct: 0,
    highValueGrants: 0,
    topCpcGroups: [],
    recentGrants: [],
    fetchedAt: new Date().toISOString(),
  };

  const apiKey = process.env.PATENTSVIEW_API_KEY;
  if (!apiKey || !companyName) {
    cache.set(cacheKey, { data: empty, at: Date.now() });
    return empty;
  }

  try {
    const to = new Date();
    const from = new Date(Date.now() - lookbackDays * 86400000);
    const priorFrom = new Date(Date.now() - lookbackDays * 2 * 86400000);

    // Query the current window + prior window in one call so we can compute velocity.
    const body = {
      q: {
        _and: [
          { _gte: { patent_date: priorFrom.toISOString().slice(0, 10) } },
          { _lte: { patent_date: to.toISOString().slice(0, 10) } },
          // PatentsView's _contains is case-insensitive on assignee_organization.
          { _contains: { 'assignees.assignee_organization': companyName } },
        ],
      },
      f: [
        'patent_id',
        'patent_title',
        'patent_date',
        'cpc_current.cpc_group_id',
        'assignees.assignee_organization',
      ],
      s: [{ patent_date: 'desc' }],
      o: { size: 500 }, // cap to avoid pagination gymnastics; most companies won't exceed this
    };

    const res = await fetch(`${PATENTSVIEW}/patent/`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      cache.set(cacheKey, { data: empty, at: Date.now() });
      return empty;
    }
    const data = (await res.json()) as { patents?: any[] };
    const patents = (data.patents ?? []).map(normalizePatent).filter(Boolean) as PatentGrant[];

    const fromIso = from.toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    const current = patents.filter((p) => p.grantDate >= fromIso);
    const prior = patents.filter((p) => p.grantDate < fromIso);

    const grantsLast30d = current.filter((p) => p.grantDate >= thirtyDaysAgo).length;
    const grantsLast90d = current.filter((p) => p.grantDate >= ninetyDaysAgo).length;

    const velocityChangePct =
      prior.length > 0 ? ((current.length - prior.length) / prior.length) * 100 : current.length > 0 ? 100 : 0;

    const highValueGrants = current.filter((p) =>
      p.cpcGroups.some((g) => HIGH_VALUE_CPC_PREFIXES.some((pref) => g.startsWith(pref))),
    ).length;

    const cpcCounts = new Map<string, number>();
    for (const p of current) {
      for (const g of p.cpcGroups) {
        // truncate to subclass level (first 4 chars) to avoid fragmentation across specific groups
        const sub = g.slice(0, 4);
        cpcCounts.set(sub, (cpcCounts.get(sub) ?? 0) + 1);
      }
    }
    const topCpcGroups = Array.from(cpcCounts.entries())
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const out: PatentActivity = {
      ticker,
      companyName,
      lookbackDays,
      totalGrants: current.length,
      grantsLast30d,
      grantsLast90d,
      priorPeriodGrants: prior.length,
      velocityChangePct: +velocityChangePct.toFixed(1),
      highValueGrants,
      topCpcGroups,
      recentGrants: current.slice(0, 10),
      fetchedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, { data: out, at: Date.now() });
    return out;
  } catch {
    cache.set(cacheKey, { data: empty, at: Date.now() });
    return empty;
  }
}

function normalizePatent(raw: any): PatentGrant | null {
  if (!raw) return null;
  const patentId = String(raw.patent_id ?? '');
  const title = String(raw.patent_title ?? '').trim();
  const grantDate = String(raw.patent_date ?? '');
  if (!patentId || !grantDate) return null;
  const cpcGroups = Array.isArray(raw.cpc_current)
    ? raw.cpc_current.map((c: any) => String(c.cpc_group_id ?? '')).filter(Boolean)
    : [];
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees.map((a: any) => String(a.assignee_organization ?? '')).filter(Boolean)
    : [];
  return { patentId, title, grantDate, cpcGroups, assignees };
}

// 0-100 patent momentum score. This is a proxy for innovation velocity —
// companies whose patent output is accelerating in high-value areas.
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

  // Volume
  if (p.totalGrants > 40) { raw += 15; parts.push(`${p.totalGrants} grants in ${p.lookbackDays}d`); }
  else if (p.totalGrants > 10) { raw += 8; parts.push(`${p.totalGrants} grants in ${p.lookbackDays}d`); }
  else if (p.totalGrants > 3) { raw += 3; parts.push(`${p.totalGrants} grants in ${p.lookbackDays}d`); }

  // Velocity
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

  // High-value concentration
  const hvShare = p.totalGrants > 0 ? p.highValueGrants / p.totalGrants : 0;
  if (hvShare > 0.3 && p.highValueGrants >= 3) {
    raw += 15;
    tags.push(`${p.highValueGrants} high-value`);
    parts.push(`${p.highValueGrants} patents in AI/bio/semi codes`);
  }

  // Recent burst
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
