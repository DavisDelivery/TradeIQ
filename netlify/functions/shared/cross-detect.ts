// Golden/death cross detection over daily bars.
//
// A golden cross fires on day T when SMA50 closes above SMA200 having been
// at-or-below it on day T-1; a death cross is the mirror. Detection uses
// completed daily closes only — no intraday flicker, so an event is final
// the evening it forms and never retroactively disappears.
//
// Pure module (no I/O): the scheduled scan feeds it bars, tests feed it
// synthetic series. Warmup rule matches chart-analysis: sma200[i] is null
// until 200 samples exist, so a cross can only be detected from bar 200 on.

export interface CrossBar {
  /** epoch ms */
  t: number;
  /** close */
  c: number;
}

export interface CrossEvent {
  type: 'golden' | 'death';
  /** YYYY-MM-DD (UTC) of the completed bar the cross fired on */
  date: string;
  /** close on the cross day */
  closeAtCross: number;
  sma50: number;
  sma200: number;
  /** completed bars since the cross (0 = fired on the latest bar) */
  barsAgo: number;
}

function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Scan a bar series (ascending by time) for every SMA50/SMA200 cross.
 * `sinceMs` bounds how far back events are reported (bars before it still
 * feed the SMAs — they just can't emit events).
 */
export function detectCrosses(bars: CrossBar[], sinceMs = 0): CrossEvent[] {
  if (bars.length < 201) return []; // need T-1 and T with a valid SMA200
  const closes = bars.map((b) => b.c);
  const s50 = smaSeries(closes, 50);
  const s200 = smaSeries(closes, 200);
  const events: CrossEvent[] = [];
  for (let i = 200; i < bars.length; i++) {
    const prev50 = s50[i - 1]; const prev200 = s200[i - 1];
    const cur50 = s50[i]; const cur200 = s200[i];
    if (prev50 == null || prev200 == null || cur50 == null || cur200 == null) continue;
    if (bars[i].t < sinceMs) continue;
    let type: CrossEvent['type'] | null = null;
    if (prev50 <= prev200 && cur50 > cur200) type = 'golden';
    else if (prev50 >= prev200 && cur50 < cur200) type = 'death';
    if (!type) continue;
    events.push({
      type,
      date: isoDay(bars[i].t),
      closeAtCross: +bars[i].c.toFixed(4),
      sma50: +cur50.toFixed(4),
      sma200: +cur200.toFixed(4),
      barsAgo: bars.length - 1 - i,
    });
  }
  return events;
}

/** Row stored in the crosses board snapshot — one per detected event. */
export interface CrossRow extends CrossEvent {
  ticker: string;
  name: string | null;
  sector: string | null;
  /** latest close at scan time */
  lastClose: number;
  /** % move from the cross-day close to the latest close */
  pctSinceCross: number;
}

export function toCrossRows(
  ticker: string,
  name: string | null,
  sector: string | null,
  bars: CrossBar[],
  events: CrossEvent[],
): CrossRow[] {
  const lastClose = bars.length ? bars[bars.length - 1].c : 0;
  return events.map((e) => ({
    ...e,
    ticker,
    name,
    sector,
    lastClose: +lastClose.toFixed(4),
    pctSinceCross: e.closeAtCross > 0
      ? +(((lastClose - e.closeAtCross) / e.closeAtCross) * 100).toFixed(2)
      : 0,
  }));
}
