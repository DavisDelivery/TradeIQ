// Government contracts provider — Quiver-backed.
//
// Federal contract awards tracked via USASpending.gov (Quiver aggregates and
// maps to tickers). Meaningful for:
//   - Defense/aerospace (LMT, RTX, NOC, GD, BA) — bookings are published
//     months before they show up in reported revenue.
//   - Cloud/infrastructure (AMZN, MSFT, ORCL) — JWCC cloud-contract awards.
//   - Biotech/pharma during procurement cycles — BARDA contracts etc.
//   - Small-caps that land their first prime DoD contract — often doubles.
//
// The signal quality is highest when:
//   - Award size is material to the company (contract > 2% of annual revenue)
//   - Multiple awards concentrate in a short window (policy tailwind)
//   - Award goes to a company that hasn't won a big one recently — regime
//     change.

import { quiverGetTicker, q, qn, qdate } from './quiver-client';

export interface GovContract {
  date: string;
  amount: number;
  agency: string;
  description?: string;
}

export interface GovContractActivity {
  ticker: string;
  lookbackDays: number;
  totalContracts: number;
  totalDollars: number;
  priorPeriodDollars: number;
  velocityChangePct: number;
  largestContract: GovContract | null;
  topAgencies: Array<{ agency: string; dollars: number; count: number }>;
  recentContracts: GovContract[];
  fetchedAt: string;
}

export async function getGovContractActivity(
  ticker: string,
  lookbackDays = 180,
): Promise<GovContractActivity> {
  const empty: GovContractActivity = {
    ticker, lookbackDays,
    totalContracts: 0, totalDollars: 0,
    priorPeriodDollars: 0, velocityChangePct: 0,
    largestContract: null, topAgencies: [], recentContracts: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    const rows = await quiverGetTicker('govcontractsall', ticker);
    if (rows.length === 0) return empty;

    const all = rows.map(normalize).filter(Boolean) as GovContract[];

    const fromIso = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const priorFromIso = new Date(Date.now() - lookbackDays * 2 * 86400000).toISOString().slice(0, 10);

    const current = all.filter((c) => c.date >= fromIso);
    const prior = all.filter((c) => c.date >= priorFromIso && c.date < fromIso);

    const totalDollars = current.reduce((a, c) => a + c.amount, 0);
    const priorDollars = prior.reduce((a, c) => a + c.amount, 0);
    const velocityChangePct = priorDollars > 0
      ? ((totalDollars - priorDollars) / priorDollars) * 100
      : totalDollars > 0 ? 100 : 0;

    const largest = current.length
      ? current.reduce((a, b) => (b.amount > a.amount ? b : a))
      : null;

    const agencyMap = new Map<string, { dollars: number; count: number }>();
    for (const c of current) {
      const cur = agencyMap.get(c.agency) ?? { dollars: 0, count: 0 };
      cur.dollars += c.amount;
      cur.count += 1;
      agencyMap.set(c.agency, cur);
    }
    const topAgencies = Array.from(agencyMap.entries())
      .map(([agency, v]) => ({ agency, dollars: +v.dollars.toFixed(0), count: v.count }))
      .sort((a, b) => b.dollars - a.dollars)
      .slice(0, 5);

    return {
      ticker, lookbackDays,
      totalContracts: current.length,
      totalDollars,
      priorPeriodDollars: priorDollars,
      velocityChangePct: +velocityChangePct.toFixed(1),
      largestContract: largest,
      topAgencies,
      recentContracts: [...current].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return empty;
  }
}

function normalize(raw: any): GovContract | null {
  if (!raw) return null;
  const date = qdate(raw, 'Date', 'ActionDate', 'date');
  if (!date) return null;
  const amount = qn(raw, 'Amount', 'Dollars', 'dollars', 'amount') ?? 0;
  return {
    date,
    amount,
    agency: String(q(raw, 'Agency', 'agency', 'AwardingAgency') ?? '').trim(),
    description: String(q(raw, 'Description', 'description', 'Award') ?? '').trim() || undefined,
  };
}

export function scoreGovContractActivity(g: GovContractActivity): {
  score: number;
  confidence: number;
  rationale: string;
  tags: string[];
} {
  const tags: string[] = [];
  const parts: string[] = [];
  let raw = 0;

  if (g.totalContracts === 0) {
    return { score: 50, confidence: 0.1, rationale: 'no recent federal contracts', tags: [] };
  }

  // Total dollar magnitude — thresholds are chosen so small-caps with
  // relatively modest awards still score, while mega-caps don't inflate.
  if (g.totalDollars > 1_000_000_000) { raw += 20; parts.push(`$${fmtK(g.totalDollars)} awarded`); }
  else if (g.totalDollars > 100_000_000) { raw += 12; parts.push(`$${fmtK(g.totalDollars)} awarded`); }
  else if (g.totalDollars > 10_000_000) { raw += 6; parts.push(`$${fmtK(g.totalDollars)} awarded`); }

  // Acceleration
  if (g.velocityChangePct > 100 && g.totalDollars > 10_000_000) {
    raw += 15;
    tags.push(`contracts +${Math.round(g.velocityChangePct)}%`);
    parts.push(`contract award velocity +${Math.round(g.velocityChangePct)}%`);
  } else if (g.velocityChangePct > 40 && g.totalDollars > 10_000_000) {
    raw += 7;
    tags.push(`contracts +${Math.round(g.velocityChangePct)}%`);
  }

  // Single whale award
  if (g.largestContract && g.largestContract.amount > 500_000_000) {
    raw += 10;
    tags.push(`$${fmtK(g.largestContract.amount)} award`);
    parts.push(`single award of $${fmtK(g.largestContract.amount)}`);
  }

  raw = Math.max(-10, Math.min(50, raw));
  const score = Math.round(50 + raw);
  const confidence = Math.min(1, g.totalContracts / 10);

  return {
    score,
    confidence,
    rationale: parts.join(', ') || 'steady contract flow',
    tags,
  };
}

function fmtK(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
