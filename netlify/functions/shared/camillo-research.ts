// CAMILLO RESEARCH — the judgment work the screen cannot do.
//
// `camillo-undiscovered` answers "could a consumer trend move this stock"
// using float, ownership and sales growth. It cannot answer the three
// questions that actually decide a social-arbitrage trade:
//
//   1. Is a trend happening, and in what?
//   2. Would it be MATERIAL to this issuer's revenue?
//   3. Has the market already repriced it?
//
// Those need reading, not filtering. This module gathers the evidence and
// hands it to the model to reason over.
//
// ---------------------------------------------------------------------------
// THE STANDING RISK, NAMED
//
// This repo's whole discipline is that narrative confidence never outranks
// measured edge (verdicts.ts, VerdictChip). An LLM writing a fluent thesis
// about a stock is exactly the thing that convention exists to contain. So:
//
//   - The model is given ONLY fetched evidence, each item labelled with its
//     source. It is told to say "not in the evidence" rather than fill gaps.
//   - It returns NO score, NO price target, NO rank. Structured verdict
//     fields are bounded enums, not numbers that could be sorted into a
//     ranking later.
//   - `unverified[]` is REQUIRED in the output contract. An answer with an
//     empty unverified list on thin evidence is itself a warning sign.
//   - The materiality question is asked explicitly, because Finviz has no
//     segment revenue and the model cannot look it up either. Barbie was
//     ~2.3% of Mattel's revenue and MAT trailed SPY by 32pp in 2023 — the
//     canonical way this strategy loses.
// ---------------------------------------------------------------------------

import { getNews, getUpcomingEarnings } from './data-provider';
import { fetchFinvizInsiders, getFinvizUniverseSnapshot, type FinvizRow } from './finviz';
import { getTickerName } from './ticker-reference';
import { fetchPageviews, resolveArticle } from './trend-exposure';
import { logger } from './logger';

const log = logger.child({ mod: 'camillo-research' });

export interface CamilloEvidence {
  ticker: string;
  /** Resolved company name (ticker-reference), not from the screener row. */
  companyName: string | null;
  asOf: string;
  /** Screener row: float, ownership, growth. Null when not in the snapshot. */
  fundamentals: FinvizRow | null;
  /** Absolute Wikipedia pageviews for the resolved article. */
  attention: {
    article: string | null;
    yoyPct: number | null;
    momPct: number | null;
    recentDailyMean: number | null;
  } | null;
  insiders: Array<{ date: string; owner: string; relationship: string; transaction: string; valueUsd: number | null }>;
  news: Array<{ date: string; title: string }>;
  nextEarnings: string | null;
  /** Sources that failed or returned nothing, by name. Fed to the model. */
  gaps: string[];
}

const iso = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Gather everything the app already has about one name.
 *
 * Every source is independently try/caught and a failure is recorded in
 * `gaps` rather than thrown. A partial evidence set is useful; a silent
 * one is not — the model is shown exactly what was missing.
 */
export async function gatherEvidence(
  ticker: string,
  universe: 'sp500' | 'russell2k' = 'russell2k',
): Promise<CamilloEvidence> {
  const t = ticker.toUpperCase();
  const gaps: string[] = [];

  const [fundamentals, insiders, news, nextEarnings] = await Promise.all([
    getFinvizUniverseSnapshot(universe)
      .then((snap) => snap?.rows?.find((r: FinvizRow) => r.ticker === t) ?? null)
      .catch((e) => { gaps.push(`finviz snapshot: ${e?.message ?? e}`); return null; }),
    fetchFinvizInsiders(t)
      .then((rows) => rows ?? [])
      .catch((e) => { gaps.push(`finviz insiders: ${e?.message ?? e}`); return []; }),
    getNews(t, 12)
      .catch((e) => { gaps.push(`news: ${e?.message ?? e}`); return []; }),
    getUpcomingEarnings(t)
      .catch((e) => { gaps.push(`earnings date: ${e?.message ?? e}`); return null; }),
  ]);

  if (!fundamentals) gaps.push(`${t} is not in the ${universe} snapshot — no float or ownership data`);

  // Wikipedia is the only CONSUMER-ATTENTION source in this codebase. It is
  // absolute daily counts, not a rescaled index, so two names are comparable.
  // It is also the leg whose predictive value measured NO_EDGE — it goes to
  // the model as context, explicitly labelled as such.
  let attention: CamilloEvidence['attention'] = null;
  let resolvedName: string | null = null;
  try {
    // A bare ticker resolves to the wrong Wikipedia article ("CROX" is not
    // "Crocs"), so resolve the real company name first.
    const name = await getTickerName(t).catch(() => null) ?? t;
    resolvedName = name === t ? null : name;
    if (name === t) gaps.push(`could not resolve a company name for ${t} — attention lookup used the ticker`);
    const article = await resolveArticle(name);
    if (article) {
      const pv = await fetchPageviews(article);
      const recent = pv.points.slice(-28);
      attention = {
        article,
        yoyPct: pv.yoyPct,
        momPct: pv.momPct,
        recentDailyMean: recent.length
          ? Math.round(recent.reduce((a, p) => a + p.views, 0) / recent.length)
          : null,
      };
      if (!pv.points.length) gaps.push(`wikipedia has no pageview record for "${article}"`);
    } else {
      gaps.push(`no wikipedia article resolved for "${name}"`);
    }
  } catch (e: any) {
    gaps.push(`wikipedia: ${e?.message ?? e}`);
  }

  log.info('evidence', { ticker: t, hasFundamentals: !!fundamentals, insiders: insiders.length, news: news.length, gaps: gaps.length });

  return {
    ticker: t,
    companyName: resolvedName,
    asOf: iso(),
    fundamentals,
    attention,
    insiders: insiders.slice(0, 10).map((i: any) => ({
      date: i.date, owner: i.owner, relationship: i.relationship,
      transaction: i.transaction, valueUsd: i.valueUsd ?? null,
    })),
    news: (news as any[]).slice(0, 10).map((n) => ({
      date: String(n.publishedUtc ?? '').slice(0, 10), title: n.title,
    })),
    nextEarnings: (nextEarnings as any)?.date ?? null,
    gaps,
  };
}

const fmtM = (n: number | null | undefined) => (n == null ? 'unknown' : `${n.toFixed(1)}M`);
const fmtPct = (n: number | null | undefined) => (n == null ? 'unknown' : `${n.toFixed(1)}%`);

export function renderEvidence(e: CamilloEvidence): string {
  const f = e.fundamentals;
  const lines: string[] = [];

  lines.push(`TICKER ${e.ticker}${e.companyName ? ` — ${e.companyName}` : ''}   (evidence gathered ${e.asOf})`);
  lines.push('');
  lines.push('— STRUCTURE (source: Finviz Elite screener snapshot) —');
  if (f) {
    lines.push(`sector: ${f.sector ?? 'unknown'}`);
    lines.push(`free float: ${fmtM(f.floatM)} shares    market cap: ${f.marketCapM == null ? 'unknown' : `$${f.marketCapM.toFixed(0)}M`}`);
    lines.push(`institutional ownership: ${fmtPct(f.instOwnPct)}   (higher = more discovered)`);
    lines.push(`insider ownership: ${fmtPct(f.insiderOwnPct)}   insider transactions: ${fmtPct(f.insiderTransPct)}`);
    lines.push(`short float: ${fmtPct(f.shortFloatPct)}`);
    lines.push(`sales growth QoQ: ${fmtPct(f.salesGrowthQoQPct)}   EPS growth QoQ: ${fmtPct(f.epsGrowthQoQPct)}`);
    lines.push(`price: ${f.price == null ? 'unknown' : `$${f.price}`}   distance from 52w high: ${fmtPct(f.high52wDistPct)}`);
    lines.push(`avg volume: ${f.avgVolume == null ? 'unknown' : `${f.avgVolume}k`}`);
  } else {
    lines.push('(not in the screener snapshot — no float or ownership data available)');
  }

  lines.push('');
  lines.push('— CONSUMER ATTENTION (source: Wikipedia daily pageviews, ABSOLUTE counts) —');
  if (e.attention) {
    lines.push(`article: ${e.attention.article}`);
    lines.push(`recent 28-day mean: ${e.attention.recentDailyMean ?? 'unknown'} views/day`);
    lines.push(`vs prior 28 days: ${e.attention.momPct == null ? 'unknown' : `${e.attention.momPct.toFixed(0)}%`}`);
    lines.push(`vs same period last year: ${e.attention.yoyPct == null ? 'unknown' : `${e.attention.yoyPct.toFixed(0)}%`}`);
    lines.push('NOTE: this leg measured NO PREDICTIVE EDGE in our own study. Treat it as');
    lines.push('descriptive colour, never as evidence that the stock will move.');
  } else {
    lines.push('(no attention data resolved)');
  }

  lines.push('');
  lines.push('— INSIDER TRANSACTIONS (source: Finviz / SEC Form 4) —');
  lines.push(e.insiders.length
    ? e.insiders.map((i) => `${i.date}  ${i.transaction.padEnd(5)}  ${i.owner} (${i.relationship})  ${i.valueUsd == null ? '' : `$${i.valueUsd.toLocaleString()}`}`).join('\n')
    : '(none in the recent window)');

  lines.push('');
  lines.push('— RECENT NEWS (source: Finnhub) —');
  lines.push(e.news.length ? e.news.map((n) => `${n.date}  ${n.title}`).join('\n') : '(none)');

  lines.push('');
  lines.push(`— NEXT EARNINGS — ${e.nextEarnings ?? 'unknown'}`);

  if (e.gaps.length) {
    lines.push('');
    lines.push('— GAPS (sources that failed or returned nothing) —');
    lines.push(e.gaps.map((g) => `- ${g}`).join('\n'));
  }
  return lines.join('\n');
}

export const SYSTEM_PROMPT = `You do social-arbitrage research in the style Chris Camillo describes: notice a real-world consumer change before Wall Street prices it, then check whether a listed company actually monetises it.

You are given ONLY the evidence block. You have no browsing and no memory of this ticker. Reason from what is there.

HARD RULES
- Never invent a fact. If the evidence does not contain something, say so and list it under unverified.
- Never output a score, a rank, a price target, or a probability. This app's convention is that a fluent paragraph must never outrank a measured backtest.
- The Wikipedia attention series measured NO predictive edge in this system's own study. You may describe it. You may not treat it as evidence the stock will move.
- Institutional ownership is the discovery gauge. High means the gap has likely closed.
- Be brief. Short sentences. No preamble, no restating the question.

THE FOUR QUESTIONS, IN ORDER
1. PRODUCT — what does this company actually sell to consumers? Name the specific product or brand. If the evidence does not say, say so plainly; that is a real finding, because a company whose product you cannot name from its own filings and news is not a social-arbitrage candidate.
2. TREND — is there any sign in the evidence of a demand change? Sales growth and insider behaviour are the strongest legs here. News is weak. Attention is descriptive only.
3. MATERIALITY — this is the question that kills most of these trades. Would the trend, if real, be a large enough share of revenue to move the stock? Mattel's Barbie film grossed $1.44bn and was ~2.3% of Mattel revenue; the stock trailed the S&P by 32 percentage points that year. State explicitly whether the evidence lets you judge materiality. Usually it will not, because there is no segment revenue here.
4. DISCOVERY — has the market already repriced it? Use institutional ownership, distance from the 52-week high, and short float.

Then give the falsifier: the single observation that would most cleanly prove this thesis wrong.

Return ONLY valid JSON, no markdown fence:
{
  "product": "1-2 sentences naming what it sells, or stating that the evidence does not say",
  "trend": "1-3 sentences on whether demand is actually changing",
  "materiality": "1-3 sentences; say outright if it cannot be judged from this evidence",
  "discovery": "1-2 sentences on how far the market has already gone",
  "readVerdict": "one of: WORTH_DIGGING | THIN | ALREADY_PRICED | NOT_A_CANDIDATE",
  "whyVerdict": "one sentence",
  "falsifier": "the single observation that would disprove the thesis",
  "nextChecks": ["2-4 specific things a human should verify by hand"],
  "unverified": ["everything you could not confirm from the evidence — REQUIRED, never empty"]
}`;

export type ReadVerdict = 'WORTH_DIGGING' | 'THIN' | 'ALREADY_PRICED' | 'NOT_A_CANDIDATE';

export interface CamilloRead {
  product: string;
  trend: string;
  materiality: string;
  discovery: string;
  readVerdict: ReadVerdict;
  whyVerdict: string;
  falsifier: string;
  nextChecks: string[];
  unverified: string[];
}

const VERDICTS: ReadVerdict[] = ['WORTH_DIGGING', 'THIN', 'ALREADY_PRICED', 'NOT_A_CANDIDATE'];

/**
 * Parse and VALIDATE the model's JSON.
 *
 * A malformed or under-specified answer throws rather than being rendered
 * as a confident read. In particular an empty `unverified` is rejected: on
 * evidence this thin, a model claiming it verified everything is the exact
 * overconfidence this endpoint exists to avoid.
 */
export function parseRead(raw: string): CamilloRead {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('model did not return JSON');
    obj = JSON.parse(m[0]);
  }

  for (const k of ['product', 'trend', 'materiality', 'discovery', 'whyVerdict', 'falsifier']) {
    if (typeof obj[k] !== 'string' || !obj[k].trim()) throw new Error(`model omitted "${k}"`);
  }
  if (!VERDICTS.includes(obj.readVerdict)) {
    throw new Error(`model returned an unknown readVerdict: ${String(obj.readVerdict)}`);
  }
  if (!Array.isArray(obj.nextChecks) || !obj.nextChecks.length) {
    throw new Error('model omitted nextChecks');
  }
  if (!Array.isArray(obj.unverified) || !obj.unverified.length) {
    throw new Error('model returned an empty unverified list — rejected as overconfident');
  }
  return obj as CamilloRead;
}
