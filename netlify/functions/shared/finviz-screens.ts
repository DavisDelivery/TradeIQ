// FVZ-3 — published screening strategies, encoded against the Finviz
// vocabulary and evaluated over the cached universe snapshot.
//
// DESIGN: a screen is (a) an optional Finviz `f=` filter string and (b) a
// post-fetch predicate over FinvizRow. Every screen that can be expressed
// entirely post-fetch IS, because that costs ZERO upstream calls — it runs
// against the universe snapshot we already cache. Only screens needing data
// outside our 51 columns pay for a dedicated export call.
//
// EVIDENCE HONESTY IS PART OF THE CONTRACT. These strategies have wildly
// different empirical support and the UI states it per screen. In particular:
//   - Piotroski, 52-week-high momentum, PEAD and low-volatility have real
//     peer-reviewed backing.
//   - Minervini and Qullamaggie are ANECDOTAL — famous, widely traded, no
//     independent backtest. Their components (momentum, high-proximity) are
//     supported; the specific checklists are not.
//   - The short-squeeze screen has evidence pointing the OTHER WAY: Boehmer/
//     Huszar/Jordan (JFE 2010) find high short interest predicts NEGATIVE
//     abnormal returns. It ships flagged as speculative, with the
//     evidence-aligned inverse offered alongside.
// Overstating any of this would make the app worse, not better: the whole
// point of the forward-test league is to find out which screens actually
// work on OUR data rather than trusting the marketing.
//
// FIDELITY LIMITS baked into Finviz's vocabulary (measured, not assumed):
//   - No 150-day or 10-day MA, no MA-slope filter, RSI is 14-period only.
//     So Minervini's 150MA legs and Qullamaggie's 10MA rule are approximated
//     and SAID to be approximated.
//   - Finviz `fa_roi` is not Greenblatt's ROIC and `fa_evebitda` is not his
//     earnings yield, so the Magic Formula here is explicitly a proxy.
//   - Sector filters are include-only; exclusions run post-fetch.

import type { FinvizRow } from './finviz';

export type EvidenceGrade =
  | 'academic' // peer-reviewed, replicated
  | 'paper-portfolio' // tracked screen / index, but cost-free assumptions
  | 'mixed' // self-reported beats independent replication
  | 'anecdotal' // famous practitioner, no independent validation
  | 'contrary'; // published evidence points against the premise

export interface ScreenDef {
  id: string;
  name: string;
  thesis: string;
  popularizedBy: string;
  evidence: EvidenceGrade;
  /** Plain-language statement of what the evidence does and does not show. */
  evidenceNote: string;
  source?: string;
  /** Finviz `f=` codes. Empty ⇒ evaluated purely over the cached universe. */
  filters: string[];
  /** Extra constraints Finviz cannot express. Applied after the fetch. */
  predicate?: (row: FinvizRow) => boolean;
  /**
   * Rank key, best-first. Screens whose published form is a RANKING (52w
   * high, Tiny Titans) rank rather than threshold, which is more faithful
   * than Finviz's coarse buckets.
   */
  rank?: (row: FinvizRow) => number | null;
  /** Caps the published list where the strategy specifies one. */
  take?: number;
  /** Honest list of criteria we could NOT reproduce. Surfaced in the UI. */
  approximations?: string[];
  /**
   * Universe the strategy is actually defined over. Verified live on prod:
   * Tiny Titans matched 0/503 on the S&P 500 and 25/1954 on the Russell 2000
   * — correct in both cases, since its published rule is a $25-250M market
   * cap band that no S&P constituent can satisfy. Same for the short-squeeze
   * screen (needs a <50M float). Without this the UI opens those screens on
   * the default large-cap universe, shows an empty board, and looks broken.
   */
  preferredUniverse?: 'sp500' | 'russell2k' | 'ndx' | 'dji';
}

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const liquid = (r: FinvizRow) => num(r.avgVolume) && r.avgVolume >= 200;

export const SCREENS: ScreenDef[] = [
  {
    id: 'high52w',
    name: '52-Week High Momentum',
    thesis: 'Nearness to the 52-week high predicts continuation better than past return itself.',
    popularizedBy: 'George & Hwang (2004)',
    evidence: 'academic',
    evidenceNote:
      'George & Hwang, Journal of Finance 59(5), found 52-week-high nearness dominates traditional momentum as a predictor, and — unusually — these returns do not reverse long-term. Replicated internationally.',
    source: 'https://www.bauer.uh.edu/tgeorge/papers/gh4-paper.pdf',
    filters: [],
    // The paper ranks on price/52w-high and holds the top band, so rank
    // rather than threshold — high52wDistPct is negative below the high.
    predicate: (r) => num(r.high52wDistPct) && r.high52wDistPct >= -10 && num(r.price) && r.price >= 10 && liquid(r),
    rank: (r) => r.high52wDistPct,
    take: 50,
  },
  {
    id: 'piotroski',
    name: 'Piotroski Value + Quality',
    thesis: 'Within cheap stocks, accounting quality separates winners from losers.',
    popularizedBy: 'Joseph Piotroski (2000)',
    evidence: 'academic',
    evidenceNote:
      'Piotroski, Journal of Accounting Research 38, reported ~23%/yr 1976-1996 — but that is the LONG-SHORT spread within the high book-to-market universe, not a long-only return. This screen implements the value + solvency legs only.',
    source: 'https://www.anderson.ucla.edu/documents/areas/prg/asam/2019/F-Score.pdf',
    filters: [],
    predicate: (r) =>
      num(r.pb) && r.pb > 0 && r.pb < 1.5 &&
      num(r.roaPct) && r.roaPct > 0 &&
      num(r.currentRatio) && r.currentRatio > 1.5 &&
      num(r.debtToEquity) && r.debtToEquity < 0.5 &&
      liquid(r),
    rank: (r) => r.roaPct,
    take: 50,
    approximations: [
      'Only 4 of the 9 F-Score signals are expressible: 5 are YEAR-OVER-YEAR CHANGES or cash-flow items (ΔROA, Δleverage, Δcurrent ratio, CFO > net income, share issuance) that need statement history, not a snapshot. This is a value+solvency pre-filter, not an F-Score.',
    ],
  },
  {
    id: 'lowvol',
    name: 'Low Volatility Quality',
    thesis: 'Low-beta, profitable, low-leverage names beat the market on a risk-adjusted basis.',
    popularizedBy: 'Baker, Bradley & Wurgler (2011)',
    evidence: 'academic',
    evidenceNote:
      'Financial Analysts Journal 67(1): over ~41 years high-volatility stocks substantially UNDERPERFORMED low-volatility ones, contradicting CAPM. Caveat: crowded since publication, and it lags badly in strong bull markets.',
    source: 'https://pages.stern.nyu.edu/~jwurgler/papers/faj-benchmarks.pdf',
    filters: [],
    predicate: (r) =>
      num(r.beta) && r.beta > 0 && r.beta < 1 &&
      num(r.roePct) && r.roePct > 15 &&
      num(r.debtToEquity) && r.debtToEquity < 0.5 &&
      num(r.marketCapM) && r.marketCapM >= 2000 &&
      liquid(r),
    rank: (r) => (num(r.beta) ? -r.beta : null),
    take: 50,
  },
  {
    id: 'pead',
    name: 'Earnings Drift (PEAD)',
    thesis: 'Prices under-react to earnings surprises and drift in the direction of the surprise.',
    popularizedBy: 'Ball & Brown (1968); Bernard & Thomas (1989)',
    evidence: 'academic',
    evidenceNote:
      'One of the most durable anomalies in finance — Bernard & Thomas found the top-vs-bottom surprise decile spread positive in 41 of 48 quarters. Direction is well established; magnitude estimates vary widely by study (roughly 5-10% per quarter for an extreme-decile long-short, before costs).',
    source: 'https://jkatz.caltech.edu/documents/28622/peads.pdf',
    filters: [],
    predicate: (r) =>
      num(r.epsGrowthQoQPct) && r.epsGrowthQoQPct > 20 &&
      num(r.perfWeekPct) && r.perfWeekPct > 3 &&
      num(r.relVolume) && r.relVolume > 1.5 &&
      num(r.price) && r.price >= 10 &&
      liquid(r),
    rank: (r) => r.epsGrowthQoQPct,
    take: 40,
    approximations: [
      'True SUE (surprise scaled by its own standard deviation) needs consensus history; EPS growth QoQ plus a post-report price/volume reaction is the available proxy.',
    ],
  },
  {
    id: 'dividend-growth',
    name: 'Dividend Growth',
    thesis: 'Durable, growing, well-covered payouts proxy for quality and capital discipline.',
    popularizedBy: 'S&P Dividend Aristocrats',
    evidence: 'paper-portfolio',
    evidenceNote:
      'The Aristocrats index returned ~11.6%/yr since 1990 with lower volatility than the S&P 500, with most of the edge from down-market protection. NOT the same as this screen: the index requires a 25-year growth streak, which no screener filter can express — and the index has lagged over the last decade.',
    source: 'https://www.spglobal.com/spdji/en/documents/research/research-sp500-dividend-aristocrats.pdf',
    filters: [],
    predicate: (r) =>
      num(r.dividendYieldPct) && r.dividendYieldPct > 2 &&
      num(r.payoutRatioPct) && r.payoutRatioPct > 0 && r.payoutRatioPct < 60 &&
      num(r.roePct) && r.roePct > 10 &&
      num(r.marketCapM) && r.marketCapM >= 2000 &&
      liquid(r),
    rank: (r) => r.dividendYieldPct,
    take: 50,
    approximations: ['No dividend-growth-streak data: the 25-year Aristocrat requirement is not reproduced.'],
  },
  {
    id: 'canslim',
    name: 'CAN SLIM',
    thesis: 'High current and annual earnings growth, near highs, institutionally owned.',
    popularizedBy: "William O'Neil / IBD",
    evidence: 'paper-portfolio',
    evidenceNote:
      "AAII has tracked a CAN SLIM screen since 1998 as a hypothetical monthly-rebalanced portfolio and reported strong annualized returns. Caveats that matter: paper portfolio, no transaction costs, no slippage, price-only. Suggestive, not proof.",
    source: 'https://www.aaii.com/journal/article/stock-screens-guide-and-tables',
    filters: ['fa_epsqoq_o25', 'fa_salesqoq_o25', 'fa_eps5years_o15', 'fa_roe_o15', 'ta_sma200_pa', 'sh_avgvol_o400'],
    predicate: (r) =>
      num(r.instOwnPct) && r.instOwnPct > 10 &&
      num(r.high52wDistPct) && r.high52wDistPct >= -15 &&
      num(r.price) && r.price >= 10,
    rank: (r) => r.epsGrowthQoQPct,
    take: 40,
    approximations: [
      "'L' (relative-strength rank) is approximated by ranking annual performance across the universe; 'M' (market direction) is a regime judgement outside any screener.",
    ],
  },
  {
    id: 'tiny-titans',
    name: 'Tiny Titans (Small-Cap Value)',
    thesis: 'Cheap-on-sales micro caps with strong relative strength.',
    popularizedBy: "James O'Shaughnessy",
    evidence: 'paper-portfolio',
    evidenceNote:
      "AAII's tracked version has compounded at roughly 26%/yr since 1998 vs ~7% for the S&P 500. Big caveat: at $25-250M market caps this is barely investable at size — the published figures exclude spread, impact and transaction costs, which routinely exceed the modelled edge in micro caps.",
    source: 'https://www.aaii.com/journal/article/oshaughnessys-tiny-titans-screen',
    filters: [],
    predicate: (r) =>
      num(r.marketCapM) && r.marketCapM >= 25 && r.marketCapM <= 250 &&
      num(r.ps) && r.ps > 0 && r.ps < 1 &&
      num(r.price) && r.price >= 3 &&
      num(r.avgVolume) && r.avgVolume >= 100,
    // The published rule is "then take the 25 highest 52-week relative strength".
    rank: (r) => r.perfYearPct,
    take: 25,
    preferredUniverse: 'russell2k',
  },
  {
    id: 'magic-formula',
    name: 'Magic Formula (proxy)',
    thesis: 'Rank on cheapness and quality together; buy the top of both.',
    popularizedBy: 'Joel Greenblatt (2005)',
    evidence: 'mixed',
    evidenceNote:
      'Greenblatt self-reported ~30.8%/yr for 1988-2004, but that is his own pre-publication backtest. Independent replication (Gray & Carlisle) found real but smaller outperformance, and found earnings yield alone with a quality filter did as well. Post-publication live results have been weaker.',
    source: 'https://www.quantifiedstrategies.com/the-magic-formula-strategy/',
    filters: [],
    predicate: (r) =>
      num(r.roicPct) && r.roicPct > 20 &&
      num(r.pe) && r.pe > 0 && r.pe < 15 &&
      num(r.marketCapM) && r.marketCapM >= 300 &&
      // Greenblatt explicitly carves out financials and utilities; Finviz
      // sector filters are include-only, so it happens here.
      r.sector !== 'Financial' && r.sector !== 'Utilities' &&
      liquid(r),
    rank: (r) => (num(r.roicPct) && num(r.pe) && r.pe > 0 ? r.roicPct / r.pe : null),
    take: 40,
    approximations: [
      "Greenblatt's ROIC is EBIT/(working capital + fixed assets) and his earnings yield is EBIT/EV. Neither is available here — ROIC and P/E stand in, so this ranks similarly but is NOT the Magic Formula.",
    ],
  },
  {
    id: 'minervini',
    name: 'Minervini Trend Template',
    thesis: 'Only buy stocks already in a confirmed stage-2 uptrend near their highs.',
    popularizedBy: 'Mark Minervini',
    evidence: 'anecdotal',
    evidenceNote:
      'No independent backtest exists. Support is Minervini\'s US Investing Championship results, which are real but unaudited as a strategy and inseparable from his discretionary entries. The components (momentum, 52-week-high proximity) have academic support; this specific 8-point checklist does not.',
    source: 'https://deepvue.com/screener/minervini-trend-template/',
    // NOTE: 'price above 50MA' and '50MA above 200MA' are the SAME Finviz
    // dropdown (ta_sma50_*), so requesting both would silently keep only the
    // last. The stacking leg stays in the filter; price-above-50MA is
    // enforced post-fetch below. The duplicate-key guard caught this.
    filters: ['ta_sma200_pa', 'ta_sma50_sa200', 'ta_perf_52w20o', 'sh_avgvol_o500'],
    predicate: (r) =>
      num(r.sma50DistPct) && r.sma50DistPct > 0 &&
      num(r.low52wDistPct) && r.low52wDistPct >= 30 &&
      num(r.high52wDistPct) && r.high52wDistPct >= -25 &&
      num(r.price) && r.price >= 10,
    rank: (r) => r.perfYearPct,
    take: 50,
    approximations: [
      'Three of the eight criteria use a 150-day moving average, which Finviz does not provide at all; the 50/200-day structure stands in for them.',
      'The "200MA trending up for at least a month" rule needs a slope, which no screener filter expresses.',
    ],
  },
  {
    id: 'qullamaggie',
    name: 'Qullamaggie Continuation',
    thesis: 'Buy tight consolidations that follow an explosive multi-week advance.',
    popularizedBy: 'Kristjan Kullamägi',
    evidence: 'anecdotal',
    evidenceNote:
      'Self-reported results only — no audited record, no backtest, no independent replication. The underlying momentum effect is well supported; this particular setup is not.',
    source: 'https://qullamaggie.com/my-3-timeless-setups-that-have-made-me-tens-of-millions/',
    // ta_perf and ta_perf2 are two INDEPENDENT slots that genuinely AND —
    // the only way to express two performance windows at once.
    filters: ['ta_perf_4w20o', 'ta_perf2_13w30o', 'ta_sma50_pa', 'ta_sma200_pa', 'sh_avgvol_o500'],
    predicate: (r) => num(r.price) && r.price >= 10 && num(r.sma20DistPct) && Math.abs(r.sma20DistPct) <= 8,
    rank: (r) => r.perfQuarterPct,
    take: 40,
    approximations: [
      'The core "riding the 10-day moving average" rule is inexpressible — Finviz has no 10-day MA, so proximity to the 20-day stands in.',
      'Volume contraction through the base and opening-range entries need intraday data.',
    ],
  },
  {
    id: 'oversold-quality',
    name: 'Oversold Quality',
    thesis: 'Buy short-term dips in structurally healthy, uptrending companies.',
    popularizedBy: 'Connors & Alvarez (mean reversion)',
    evidence: 'anecdotal',
    evidenceNote:
      "Connors' results are self-published and sold as a product, tested largely in-sample over a period favourable to equity mean reversion. Short-horizon reversal is a documented effect but is mostly a liquidity-provision premium that decays after costs. Note Finviz offers only 14-period RSI, so this is a generic oversold screen, not Connors' RSI-2 strategy.",
    filters: [],
    predicate: (r) =>
      num(r.rsi14) && r.rsi14 < 35 &&
      num(r.sma200DistPct) && r.sma200DistPct > 0 &&
      num(r.roePct) && r.roePct > 15 &&
      num(r.debtToEquity) && r.debtToEquity < 1 &&
      num(r.marketCapM) && r.marketCapM >= 2000 &&
      liquid(r),
    rank: (r) => (num(r.rsi14) ? -r.rsi14 : null),
    take: 40,
  },
  {
    id: 'low-short-interest',
    name: 'Low Short Interest + Trend',
    thesis: 'Heavily-traded stocks with little short interest earn positive abnormal returns.',
    popularizedBy: 'Boehmer, Huszár & Jordan (2010)',
    evidence: 'academic',
    evidenceNote:
      'Journal of Financial Economics 96(1): the reliable side of the short-interest signal is the LONG side — heavily-traded, LOW-short-interest stocks earn significant positive abnormal returns, larger in absolute terms than the negative returns on heavily-shorted names.',
    source: 'https://www.sciencedirect.com/science/article/abs/pii/S0304405X09002402',
    filters: [],
    predicate: (r) =>
      num(r.shortFloatPct) && r.shortFloatPct < 2 &&
      num(r.sma200DistPct) && r.sma200DistPct > 0 &&
      num(r.avgVolume) && r.avgVolume >= 1000 &&
      num(r.price) && r.price >= 10,
    rank: (r) => r.perfQuarterPct,
    take: 40,
  },
  {
    id: 'camillo-undiscovered',
    name: 'Undiscovered Consumer',
    thesis:
      'A consumer-facing company small enough that a real demand shift moves the stock, ' +
      'and not yet crowded with institutions. The STRUCTURAL preconditions of social ' +
      'arbitrage — not the trend signal itself.',
    popularizedBy: 'Chris Camillo',
    evidence: 'anecdotal',
    evidenceNote:
      'Camillo\'s record is self-reported and reviewed, not audited: Jack Schwager read ' +
      'his brokerage statements ($84k Aug-2006 to $42M May-2021) but that is an author\'s ' +
      'review, not a CPA audit, and the widely quoted 68%/77% are ARITHMETIC AVERAGES of ' +
      'annual returns — the compound rate is ~48% CAGR. His one fiduciary vehicle (Social ' +
      'Information Arbitrage LP, CIK 0001606432) raised $0 and has filed nothing since 2014, ' +
      'so no LP or auditor has ever struck his numbers. CRITICALLY: we measured the ' +
      'attention half of his method on our own data and it FAILED ITS PLACEBO TEST ' +
      '(reports/trend/social-arb-study.md, verdict NO_EDGE) — random entry into the same ' +
      'names matched it. So this screen deliberately ships the STRUCTURAL half only: the ' +
      'float, ownership and demand-growth conditions under which a trend COULD move a ' +
      'stock. It does not claim to know that a trend is happening.',
    source: 'https://www.businessinsider.com/how-to-invest-social-arbitrage-strategy-chris-camillo-2021-8',
    filters: [],
    predicate: (r) =>
      // Consumer-facing. Finviz sector filters are include-only, so post-fetch.
      (r.sector === 'Consumer Cyclical' || r.sector === 'Consumer Defensive') &&
      // FLOAT is the gate that separates names retail flow can move from names
      // it cannot. The winners in the study had 40-90x smaller floats than the
      // absorbers (ELF 56.9M, CROX 47.7M vs PG 2,326.8M).
      num(r.floatM) && r.floatM <= 250 &&
      // Not yet crowded. High institutional ownership IS the closed-gap state.
      num(r.instOwnPct) && r.instOwnPct <= 70 &&
      // Operator-aligned. Camillo favours founder/insider-heavy names.
      num(r.insiderOwnPct) && r.insiderOwnPct >= 3 &&
      // DEMAND, not attention. Signals from what consumers DO (revenue, sales
      // rank, downloads) do not reverse; signals from what people LOOK AT do
      // (Da/Engelberg/Gao 2011, reversing weeks 5-52). Sales growth is the
      // only "do" measure in the Finviz column set.
      num(r.salesGrowthQoQPct) && r.salesGrowthQoQPct >= 10 &&
      // Exclude collapses — a broken thesis is not an undiscovered one.
      num(r.high52wDistPct) && r.high52wDistPct >= -50 &&
      liquid(r),
    // Least discovered first: lowest institutional ownership ranks best.
    rank: (r) => (num(r.instOwnPct) ? -r.instOwnPct : null),
    take: 40,
    approximations: [
      'The social-arbitrage SIGNAL is absent by design — it measured NO_EDGE. Use the Trend Exposure tab to ask whether a trend exists and who discloses it.',
      'Sales growth QoQ is a weak proxy for the consumer-demand data Camillo actually buys (credit-card panels, six figures a year).',
      'No materiality test: Finviz has no segment revenue, so a trending product immaterial to the parent still passes (Mattel/Barbie was 2.3% of revenue and MAT underperformed SPY by 32pp in 2023).',
      'Insider ownership is a level, not a change — it does not detect recent insider buying.',
    ],
    // Small float + sub-70% institutional ownership is structurally a
    // small/mid-cap condition; on the S&P this matches almost nothing.
    preferredUniverse: 'russell2k',
  },
  {
    id: 'short-squeeze',
    name: 'Short Squeeze Candidates',
    thesis: 'Crowded shorts plus upside momentum can force covering.',
    popularizedBy: 'Retail / event traders',
    evidence: 'contrary',
    evidenceNote:
      'PUBLISHED EVIDENCE POINTS THE OTHER WAY. Boehmer/Huszár/Jordan (JFE 2010) found high short interest predicts NEGATIVE abnormal returns, and short interest also predicts future bad news and negative earnings surprises. Squeezes are real but fat-tailed and rare; the unconditional expectation is negative. Shipped as a speculative event screen — see "Low Short Interest + Trend" for the evidence-aligned version.',
    source: 'https://alphaarchitect.com/the-good-news-in-short-interest/',
    filters: [],
    predicate: (r) =>
      num(r.shortFloatPct) && r.shortFloatPct > 20 &&
      num(r.sma50DistPct) && r.sma50DistPct > 0 &&
      num(r.perfMonthPct) && r.perfMonthPct > 10 &&
      num(r.floatM) && r.floatM < 50 &&
      num(r.price) && r.price >= 5 &&
      liquid(r),
    rank: (r) => r.shortFloatPct,
    take: 30,
    preferredUniverse: 'russell2k',
  },
];

export const SCREENS_BY_ID = new Map(SCREENS.map((s) => [s.id, s]));

export interface ScreenRunResult {
  screen: ScreenDef;
  rows: FinvizRow[];
  /** Universe size the predicate was evaluated against. */
  universeChecked: number;
}

/**
 * Apply a screen to an already-fetched universe. Pure — no I/O — so the
 * board's scan path and the tests exercise exactly the same code.
 *
 * Rows failing the predicate are dropped; remaining rows are ranked
 * best-first when the screen defines a ranking, then capped at `take`.
 * A row whose rank value is missing sorts last rather than being dropped:
 * absent data is not evidence of a bad candidate, but it should not
 * outrank a measured one.
 */
export function applyScreen(screen: ScreenDef, universe: FinvizRow[]): ScreenRunResult {
  let rows = screen.predicate ? universe.filter((r) => screen.predicate!(r)) : [...universe];

  if (screen.rank) {
    rows.sort((a, b) => {
      const av = screen.rank!(a);
      const bv = screen.rank!(b);
      if (av === null || av === undefined || !Number.isFinite(av)) return 1;
      if (bv === null || bv === undefined || !Number.isFinite(bv)) return -1;
      return bv - av;
    });
  }
  if (screen.take) rows = rows.slice(0, screen.take);

  return { screen, rows, universeChecked: universe.length };
}
