import type { Bar, FundamentalsSnapshot, NewsItem, UpcomingEarning, EarningsSurprise } from '../shared/data-provider';
import type { AnalystOutput, Direction } from '../shared/types';

// ---------------------------------------------------------------------------
// Fundamental
// ---------------------------------------------------------------------------
export function runFundamental(f: FundamentalsSnapshot | null): AnalystOutput {
  if (!f) return { score: 50, direction: 'neutral', confidence: 0, rationale: 'no fundamentals', signals: {} };
  let raw = 0;
  const s: Record<string, any> = {};
  const parts: string[] = [];

  if (f.revenueGrowthYoY !== undefined) {
    s.revGrowthYoYPct = +(f.revenueGrowthYoY * 100).toFixed(1);
    const g = f.revenueGrowthYoY;
    if (g > 0.2) { raw += 25; parts.push(`revenue +${(g * 100).toFixed(0)}% YoY`); }
    else if (g > 0.1) { raw += 15; }
    else if (g < -0.05) { raw -= 20; parts.push('revenue declining'); }
  }
  if (f.epsGrowthYoY !== undefined) {
    s.epsGrowthYoYPct = +(f.epsGrowthYoY * 100).toFixed(1);
    if (f.epsGrowthYoY > 0.25) raw += 20;
    else if (f.epsGrowthYoY > 0.1) raw += 10;
    else if (f.epsGrowthYoY < -0.1) raw -= 20;
  }
  if (f.operatingMargin !== undefined) {
    s.operatingMarginPct = +(f.operatingMargin * 100).toFixed(1);
    if (f.operatingMargin > 0.25) { raw += 15; parts.push(`op margin ${(f.operatingMargin * 100).toFixed(0)}%`); }
    else if (f.operatingMargin > 0.15) raw += 8;
    else if (f.operatingMargin < 0) raw -= 15;
  }
  if (f.operatingMargin !== undefined && f.priorOperatingMargin !== undefined) {
    const delta = f.operatingMargin - f.priorOperatingMargin;
    s.marginDeltaBps = Math.round(delta * 10000);
    if (delta > 0.01) raw += 10;
    else if (delta < -0.01) raw -= 10;
  }
  if (f.debtToEquity !== undefined) {
    s.debtToEquity = +f.debtToEquity.toFixed(2);
    if (f.debtToEquity < 0.3) raw += 5;
    else if (f.debtToEquity > 2) { raw -= 15; parts.push('high debt'); }
  }
  raw = clamp(raw, -100, 100);
  const direction: Direction = raw > 10 ? 'long' : raw < -10 ? 'short' : 'neutral';
  return {
    score: Math.round(50 + raw / 2),
    direction,
    confidence: countDefined([f.revenueGrowthYoY, f.epsGrowthYoY, f.operatingMargin]) >= 2 ? 0.75 : 0.3,
    rationale: parts.join(', ') || 'fundamentals neutral',
    signals: s,
  };
}

// ---------------------------------------------------------------------------
// Flow (volume/price proxy for institutional flow)
// ---------------------------------------------------------------------------
export function runFlow(bars: Bar[]): AnalystOutput {
  if (bars.length < 30) return { score: 50, direction: 'neutral', confidence: 0, rationale: 'insufficient history', signals: {} };

  const recent = bars.slice(-20);
  const adv30 = avg(bars.slice(-30).map((b) => b.v));

  let conc = 0;
  for (let i = 1; i < recent.length; i++) {
    const up = recent[i].c > recent[i - 1].c;
    const hi = recent[i].v > adv30;
    if (up && hi) conc++;
    else if (!up && hi) conc--;
  }
  const concScore = (conc / 20) * 25;

  const recent5Vol = avg(bars.slice(-5).map((b) => b.v));
  const advRatio = adv30 > 0 ? recent5Vol / adv30 : 1;
  const recent5Ret = bars.at(-1)!.c / bars.at(-6)!.c - 1;
  let advScore = advRatio > 1.5 ? 12 : advRatio < 0.6 ? -8 : 0;
  if (recent5Ret < 0 && advScore > 0) advScore = -advScore;

  const closeStr = avg(recent.slice(-10).map((b) => {
    const r = b.h - b.l;
    return r > 0 ? (b.c - b.l) / r : 0.5;
  }));
  const closeScore = (closeStr - 0.5) * 40;

  let raw = concScore + advScore + closeScore;
  raw = clamp(raw, -100, 100);
  const direction: Direction = raw > 10 ? 'long' : raw < -10 ? 'short' : 'neutral';

  const parts: string[] = [];
  if (conc >= 5) parts.push('accumulation pattern');
  else if (conc <= -5) parts.push('distribution');
  if (advRatio > 1.5) parts.push(`vol ${advRatio.toFixed(1)}x avg`);
  if (closeStr > 0.7) parts.push('closing near highs');
  else if (closeStr < 0.3) parts.push('closing near lows');

  return {
    score: Math.round(50 + raw / 2),
    direction,
    confidence: clamp(Math.abs(raw) / 50, 0, 0.85),
    rationale: parts.join(', ') || 'neutral flow',
    signals: {
      concordance: conc,
      advRatio: +advRatio.toFixed(2),
      closeStrengthPct: +(closeStr * 100).toFixed(0),
    },
  };
}

// ---------------------------------------------------------------------------
// Earnings (timing + surprise history)
// ---------------------------------------------------------------------------
export function runEarnings(upcoming: UpcomingEarning | null, history: EarningsSurprise[]): AnalystOutput {
  let raw = 0;
  const s: Record<string, any> = {};
  const parts: string[] = [];

  if (upcoming?.date) {
    const days = Math.round((new Date(upcoming.date).getTime() - Date.now()) / 86400000);
    s.daysUntilEarnings = days;
    s.earningsDate = upcoming.date;
    if (days >= 0 && days <= 5) { raw -= 30; parts.push(`earnings in ${days}d, de-rated`); }
    else if (days >= 0 && days <= 10) raw -= 10;
    else if (days >= 0 && days <= 21) parts.push(`earnings in ${days}d`);
  }
  if (history.length >= 2) {
    const beats = history.slice(0, 4).filter((q) => q.epsActual > q.epsEstimate).length;
    s.beats4q = beats;
    if (beats >= 3) { raw += 20; parts.push(`${beats}/4 beats`); }
    else if (beats <= 1 && history.length >= 4) { raw -= 15; parts.push(`only ${beats}/4 beats`); }
  }

  raw = clamp(raw, -100, 100);
  const direction: Direction = raw > 5 ? 'long' : raw < -5 ? 'short' : 'neutral';
  return {
    score: Math.round(50 + raw / 2),
    direction,
    confidence: history.length >= 2 ? 0.7 : 0.4,
    rationale: parts.join(', ') || 'no earnings catalyst',
    signals: s,
  };
}

// ---------------------------------------------------------------------------
// News sentiment (rule-based — AI-based version lives in the claude endpoint)
// ---------------------------------------------------------------------------
const BEARISH_KEYWORDS = ['downgrade', 'miss', 'cuts', 'slashes', 'lawsuit', 'probe', 'investigation', 'declining', 'layoffs', 'warning', 'below', 'weakness', 'fraud', 'sec charges'];
const BULLISH_KEYWORDS = ['upgrade', 'beat', 'raises', 'record', 'approval', 'launches', 'buyback', 'dividend increase', 'exceeds', 'accelerat', 'wins', 'contract', 'partnership'];

export function runNewsSentiment(news: NewsItem[]): AnalystOutput {
  if (news.length === 0) {
    return { score: 50, direction: 'neutral', confidence: 0, rationale: 'no recent news', signals: { newsCount: 0 } };
  }
  const now = Date.now();
  let raw = 0;
  let weighted = 0;
  let weightTotal = 0;
  const materialEvents: string[] = [];

  for (const n of news.slice(0, 15)) {
    const ageDays = Math.max(0, (now - new Date(n.publishedUtc).getTime()) / 86400000);
    const decay = Math.exp(-ageDays / 3);
    const text = (n.title + ' ' + (n.description ?? '')).toLowerCase();
    let itemScore = 0;
    for (const k of BULLISH_KEYWORDS) if (text.includes(k)) { itemScore += 15; materialEvents.push(n.title); break; }
    for (const k of BEARISH_KEYWORDS) if (text.includes(k)) { itemScore -= 15; materialEvents.push(n.title); break; }
    weighted += itemScore * decay;
    weightTotal += decay;
  }
  raw = weightTotal > 0 ? weighted / weightTotal : 0;
  raw = clamp(raw * 3, -100, 100); // scale up

  const direction: Direction = raw > 10 ? 'long' : raw < -10 ? 'short' : 'neutral';
  return {
    score: Math.round(50 + raw / 2),
    direction,
    confidence: Math.min(1, news.length / 10),
    rationale: materialEvents.length > 0
      ? `${materialEvents.length} material items: ${materialEvents[0].slice(0, 80)}`
      : `${news.length} headlines, mixed`,
    signals: {
      newsCount: news.length,
      materialEventCount: materialEvents.length,
    },
  };
}

function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function countDefined(xs: any[]): number { return xs.filter((x) => x !== undefined).length; }
