// Political activity provider — Quiver-backed.
//
// Combines three Quiver datasets that together form what I call a "political
// footprint" for a ticker:
//
//   1. CONGRESSIONAL TRADING — trades disclosed by senators and house reps
//      under the STOCK Act of 2012. Why this matters:
//      - Published academic work (Ziobrowski et al.) showed Senate trades
//        historically outperformed the market by 10%+ annually. House trades
//        have a smaller but still positive edge.
//      - Post-2012 transparency rules weakened the edge but it's still there,
//        especially concentrated in committee members trading stocks in their
//        oversight sectors (defense, healthcare, tech).
//      - Bipartisan buying (both R and D members loading up) is the strongest
//        configuration — reduces the chance it's a partisan narrative play.
//
//   2. CORPORATE LOBBYING — quarterly LD-2 filings showing $ spent lobbying
//      Congress. Matters because:
//      - Lobbying surges often precede regulatory wins (FDA approvals, tariff
//        carve-outs, subsidy programs).
//      - Acceleration matters more than absolute level — a company that
//        jumped from $200K/qtr to $2M/qtr is positioning for something.
//
//   3. Not included here: government contracts — that's a separate provider
//      since the scoring logic is quite different.

import { quiverGetTicker, q, qn, qdate } from './quiver-client';

export interface CongressTrade {
  politician: string;
  chamber: 'senate' | 'house';
  party?: string;
  transactionType: 'buy' | 'sell' | 'exchange';
  date: string;
  amountMin: number;       // disclosure ranges — "$1,001-$15,000" style
  amountMax: number;
  state?: string;
}

export interface LobbyingFiling {
  date: string;           // quarter-end
  amount: number;
  client: string;
  registrant?: string;
  issue?: string;
}

export interface PoliticalActivity {
  ticker: string;
  lookbackDays: number;

  // Congress
  totalTrades: number;
  netTrades: number;           // buys - sells
  uniquePoliticians: number;
  bipartisan: boolean;         // both R and D members trading same direction
  largestTrade: { politician: string; amount: number; type: string } | null;
  recentTrades: CongressTrade[];

  // Lobbying
  totalLobbyingDollars: number;
  priorPeriodLobbyingDollars: number;
  lobbyingVelocityPct: number;
  latestLobbyingQuarter: number;   // most recent quarter $
  recentFilings: LobbyingFiling[];

  fetchedAt: string;
}

export async function getPoliticalActivity(
  ticker: string,
  lookbackDays = 180,
): Promise<PoliticalActivity> {
  const empty: PoliticalActivity = {
    ticker, lookbackDays,
    totalTrades: 0, netTrades: 0, uniquePoliticians: 0,
    bipartisan: false, largestTrade: null, recentTrades: [],
    totalLobbyingDollars: 0, priorPeriodLobbyingDollars: 0,
    lobbyingVelocityPct: 0, latestLobbyingQuarter: 0, recentFilings: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    const fromIso = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const priorFromIso = new Date(Date.now() - lookbackDays * 2 * 86400000).toISOString().slice(0, 10);

    const [senateRows, houseRows, lobbyingRows] = await Promise.all([
      quiverGetTicker('senatetrading', ticker),
      quiverGetTicker('housetrading', ticker),
      quiverGetTicker('lobbying', ticker),
    ]);

    const senateTrades = senateRows.map((r) => normalizeTrade(r, 'senate')).filter(Boolean) as CongressTrade[];
    const houseTrades = houseRows.map((r) => normalizeTrade(r, 'house')).filter(Boolean) as CongressTrade[];
    const allTrades = [...senateTrades, ...houseTrades];
    const recent = allTrades.filter((t) => t.date >= fromIso);

    const buys = recent.filter((t) => t.transactionType === 'buy');
    const sells = recent.filter((t) => t.transactionType === 'sell');
    const uniquePoliticians = new Set(recent.map((t) => t.politician)).size;

    // Bipartisan detection — are both R and D members buying?
    const parties = new Set(buys.map((t) => (t.party ?? '').charAt(0).toUpperCase()).filter(Boolean));
    const bipartisan = parties.has('R') && parties.has('D');

    const largest = recent.length
      ? recent.reduce((a, b) => (b.amountMax > a.amountMax ? b : a))
      : null;

    // Lobbying
    const lobbyingAll = lobbyingRows.map(normalizeLobbying).filter(Boolean) as LobbyingFiling[];
    const lobbyingCurrent = lobbyingAll.filter((f) => f.date >= fromIso);
    const lobbyingPrior = lobbyingAll.filter((f) => f.date >= priorFromIso && f.date < fromIso);

    const totalLobbyingDollars = lobbyingCurrent.reduce((a, f) => a + f.amount, 0);
    const priorPeriodLobbyingDollars = lobbyingPrior.reduce((a, f) => a + f.amount, 0);
    const lobbyingVelocityPct = priorPeriodLobbyingDollars > 0
      ? ((totalLobbyingDollars - priorPeriodLobbyingDollars) / priorPeriodLobbyingDollars) * 100
      : totalLobbyingDollars > 0 ? 100 : 0;

    const sortedFilings = [...lobbyingCurrent].sort((a, b) => b.date.localeCompare(a.date));
    const latestQuarter = sortedFilings[0]?.amount ?? 0;

    return {
      ticker, lookbackDays,
      totalTrades: recent.length,
      netTrades: buys.length - sells.length,
      uniquePoliticians,
      bipartisan,
      largestTrade: largest ? {
        politician: largest.politician,
        amount: largest.amountMax,
        type: largest.transactionType,
      } : null,
      recentTrades: recent.slice(0, 15),
      totalLobbyingDollars,
      priorPeriodLobbyingDollars,
      lobbyingVelocityPct: +lobbyingVelocityPct.toFixed(1),
      latestLobbyingQuarter: latestQuarter,
      recentFilings: sortedFilings.slice(0, 10),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return empty;
  }
}

function normalizeTrade(raw: any, chamber: 'senate' | 'house'): CongressTrade | null {
  if (!raw) return null;
  const politician = String(q(raw, 'Representative', 'Senator', 'Name', 'politician') ?? '').trim();
  if (!politician) return null;

  const date = qdate(raw, 'Date', 'TransactionDate', 'date');
  if (!date) return null;

  // Transaction type — Quiver uses "Purchase" / "Sale" / "Exchange" typically.
  const rawType = String(q(raw, 'Transaction', 'TransactionType', 'transaction') ?? '').toLowerCase();
  const transactionType: 'buy' | 'sell' | 'exchange' =
    rawType.startsWith('purchase') || rawType.startsWith('buy') ? 'buy' :
    rawType.startsWith('sale') || rawType.startsWith('sell') ? 'sell' : 'exchange';

  // Amount fields — disclosures are ranges. Quiver often exposes them as
  // "$1,001 - $15,000" strings or as separate AmountMin/AmountMax.
  let amountMin = qn(raw, 'AmountMin', 'amountMin') ?? 0;
  let amountMax = qn(raw, 'AmountMax', 'amountMax') ?? 0;
  if (!amountMin && !amountMax) {
    const rangeStr = String(q(raw, 'Range', 'Amount', 'amount') ?? '');
    const nums = rangeStr.match(/\$?([\d,]+)/g);
    if (nums && nums.length >= 2) {
      amountMin = Number(nums[0].replace(/[^\d]/g, '')) || 0;
      amountMax = Number(nums[1].replace(/[^\d]/g, '')) || 0;
    } else if (nums && nums.length === 1) {
      amountMax = amountMin = Number(nums[0].replace(/[^\d]/g, '')) || 0;
    }
  }

  return {
    politician,
    chamber,
    party: String(q(raw, 'Party', 'party') ?? '').trim() || undefined,
    transactionType,
    date,
    amountMin,
    amountMax,
    state: String(q(raw, 'State', 'state') ?? '').trim() || undefined,
  };
}

function normalizeLobbying(raw: any): LobbyingFiling | null {
  if (!raw) return null;
  const date = qdate(raw, 'Date', 'date', 'Quarter', 'QuarterEnd');
  if (!date) return null;
  const amount = qn(raw, 'Amount', 'amount', 'Dollars') ?? 0;
  return {
    date,
    amount,
    client: String(q(raw, 'Client', 'client', 'Company') ?? '').trim(),
    registrant: String(q(raw, 'Registrant', 'registrant') ?? '').trim() || undefined,
    issue: String(q(raw, 'Issue', 'issue', 'IssueCode') ?? '').trim() || undefined,
  };
}

// 0-100 political tailwind score. Bullish configurations score high; bearish
// (net politician selling with no lobbying activity) scores low.
export function scorePoliticalActivity(p: PoliticalActivity): {
  score: number;
  confidence: number;
  rationale: string;
  tags: string[];
} {
  const tags: string[] = [];
  const parts: string[] = [];
  let raw = 0;

  if (p.totalTrades === 0 && p.totalLobbyingDollars === 0) {
    return { score: 50, confidence: 0.1, rationale: 'no political activity', tags: [] };
  }

  // Congress net direction
  if (p.netTrades >= 3) {
    raw += Math.min(20, p.netTrades * 5);
    tags.push(`${p.netTrades} net congress buys`);
    parts.push(`${p.netTrades} net congress purchases`);
  } else if (p.netTrades <= -3) {
    raw -= Math.min(15, Math.abs(p.netTrades) * 4);
    parts.push(`${Math.abs(p.netTrades)} net congress sales`);
  }

  // Bipartisan — strongest configuration
  if (p.bipartisan && p.netTrades > 0) {
    raw += 15;
    tags.push('bipartisan buying');
    parts.push('both parties buying');
  }

  // Single large-dollar disclosure
  if (p.largestTrade && p.largestTrade.type === 'buy' && p.largestTrade.amount >= 500_000) {
    raw += 10;
    tags.push('whale disclosure');
    parts.push(`${p.largestTrade.politician} disclosed $${fmtK(p.largestTrade.amount)}+ buy`);
  }

  // Lobbying velocity — acceleration is the signal
  if (p.lobbyingVelocityPct > 100 && p.totalLobbyingDollars > 500_000) {
    raw += 15;
    tags.push(`lobbying +${Math.round(p.lobbyingVelocityPct)}%`);
    parts.push(`lobbying spend ${Math.round(p.lobbyingVelocityPct)}% higher vs prior period`);
  } else if (p.lobbyingVelocityPct > 40 && p.totalLobbyingDollars > 250_000) {
    raw += 7;
    tags.push(`lobbying +${Math.round(p.lobbyingVelocityPct)}%`);
  }

  raw = Math.max(-40, Math.min(50, raw));
  const score = Math.round(50 + raw);
  const confidence = Math.min(1, (p.totalTrades + p.recentFilings.length) / 8);

  return {
    score,
    confidence,
    rationale: parts.join(', ') || 'minor political activity',
    tags,
  };
}

function fmtK(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
