// FIX-2 W2 — the I/O half of the event study: for one ticker, pull its
// earnings history + price bars over the window and window each print into
// a StudyEvent. The math (bucketing, t-stats) is the pure sibling
// `earnings-study.ts`; this file only fetches + windows.
//
// This is a RETROSPECTIVE study, so — unlike the backtest scorer — it does
// NOT asOf-filter the earnings history: we want every historical print's
// realized reaction. The one residual look-ahead is EPS restatement
// (surprisePct as reported today may differ from as-first-released); it is
// documented as a residual, same as the live scan's PIT caveat.

import { getDailyBars, getEarningsHistory } from './data-provider';
import { computeRegime } from './regime';
import { buildEvent, type RegimeTag, type StudyEvent, type StudyBar } from './earnings-study';

/** Bars buffer past windowEnd so fwdRet60 resolves for late-window prints. */
const FWD_BUFFER_DAYS = 120;
/** Bars buffer before windowStart so an early-window print has a day-0 bar. */
const PRE_BUFFER_DAYS = 10;
/** Earnings-history depth: ~10y of quarterly covers a 7y window with slack. */
const HISTORY_LIMIT = 44;

function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Regime tag at an announce date, memoized at MONTH granularity. Regime is
 * a slow macro state (VIX band + curve), so a per-print FRED call would be
 * ~14k redundant fetches across a universe; month-keying cuts that to
 * ~84 while keeping the risk_on/neutral/risk_off cut honest. The reduced
 * within-month resolution is stated in the study's method note.
 */
export async function regimeForDate(
  announceDate: string,
  cache: Map<string, RegimeTag | null>,
): Promise<RegimeTag | null> {
  const monthKey = announceDate.slice(0, 7); // YYYY-MM
  if (cache.has(monthKey)) return cache.get(monthKey) ?? null;
  let tag: RegimeTag | null = null;
  try {
    const r = await computeRegime({ asOfDate: announceDate });
    tag = r?.regime ?? null;
  } catch {
    tag = null;
  }
  cache.set(monthKey, tag);
  return tag;
}

/**
 * Fetch + window every earnings event for `ticker` whose announcement
 * falls inside [windowStart, windowEnd]. Returns [] on any data gap
 * (missing bars / history) — a name that can't be resolved contributes
 * nothing rather than poisoning the aggregate.
 */
export async function gatherTickerEvents(
  ticker: string,
  windowStart: string,
  windowEnd: string,
  regimeCache: Map<string, RegimeTag | null>,
): Promise<StudyEvent[]> {
  const barsFrom = addDaysIso(windowStart, -PRE_BUFFER_DAYS);
  const barsTo = addDaysIso(windowEnd, FWD_BUFFER_DAYS);

  let bars: StudyBar[];
  try {
    bars = (await getDailyBars(ticker, barsFrom, barsTo)) as StudyBar[];
  } catch {
    return [];
  }
  if (!bars || bars.length < 30) return [];

  // Retrospective: ALL announce dates joined, no asOf filter.
  const history = await getEarningsHistory(ticker, HISTORY_LIMIT, {
    withAnnounceDates: true,
  }).catch(() => []);

  const out: StudyEvent[] = [];
  for (const h of history) {
    if (!h.announceDate) continue;
    if (h.announceDate < windowStart || h.announceDate > windowEnd) continue;
    const surprise = h.surprisePct;
    if (surprise === undefined || !Number.isFinite(surprise)) continue;
    const regime = await regimeForDate(h.announceDate, regimeCache);
    const event = buildEvent(ticker, h.announceDate, surprise, bars, regime);
    if (event) out.push(event);
  }
  return out;
}
