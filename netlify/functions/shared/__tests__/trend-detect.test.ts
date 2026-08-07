import { describe, expect, it } from 'vitest';
import {
  DETECT_CAVEAT,
  MIN_APP_HISTORY_DAYS,
  MIN_BASELINE_VIEWS,
  MIN_MENTION_HISTORY_DAYS,
  SATURATION,
  THRESHOLDS,
  WINDOW,
  appRatingSeries,
  appRatingSpikeOf,
  articleMatchesCompany,
  assessCandidate,
  controlCohort,
  mentionSeries,
  mentionSpikeOf,
  pctChange,
  recentVsBase,
  selectMoved,
  significantTokens,
  type TrendCandidate,
} from '../trend-detect';
import type { MentionSnapshot } from '../social-mentions';

const views = (xs: number[]) => xs.map((v) => ({ views: v }));
const flat = (n: number, v: number) => new Array(n).fill(v);

describe('pctChange — the zero baseline is the point, not an edge case', () => {
  it('measures an ordinary rise', () => {
    expect(pctChange(150, 100)).toBeCloseTo(50);
  });

  it('reports a rise from zero as UNBOUNDED, not as missing data', () => {
    // A name going from no recorded mentions to forty is the loudest thing
    // this tool can see. Returning null here would file it as "no data".
    expect(pctChange(40, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports a genuine 0 -> 0 as no change', () => {
    expect(pctChange(0, 0)).toBe(0);
  });
});

describe('recentVsBase — the detector\'s statistic', () => {
  it('needs a full recent + base window before it will answer', () => {
    const r = recentVsBase(views(flat(WINDOW.recentDays + WINDOW.baseDays - 1, 100)));
    expect(r.pct).toBeNull();
    expect(r.reason).toMatch(/need 35/);
  });

  it('compares the recent window against the baseline immediately before it', () => {
    const r = recentVsBase(views([...flat(WINDOW.baseDays, 100), ...flat(WINDOW.recentDays, 200)]));
    expect(r.pct).toBeCloseTo(100);
    expect(r.baselineMean).toBeCloseTo(100);
  });

  it('refuses a percentage on a baseline too thin to take one of', () => {
    // 3/day going to 5/day is +67% and means nothing. It is also what a
    // MIS-RESOLVED Wikipedia article looks like — a plausible title with a
    // fraction of the real page's traffic.
    const r = recentVsBase(views([...flat(WINDOW.baseDays, 3), ...flat(WINDOW.recentDays, 5)]));
    expect(r.pct).toBeNull();
    expect(r.baselineMean).toBeLessThan(MIN_BASELINE_VIEWS);
    expect(r.reason).toMatch(/below the 30\/day floor/);
  });

  it('is materially faster than the 28d-vs-28d statistic it replaces', () => {
    // A 1.6x step that started 7 days ago — a MODERATE onset, which is the
    // case that matters: probed against live Wikimedia data over 32 real
    // onsets, 28-vs-28 never fired at all on 10 of them and lagged the rest
    // by a median ~8 days. The detector's 7-vs-28 sees this step in full;
    // 28-vs-28 dilutes it across four weeks and lands under the 25% bar.
    const series = [...flat(60, 100), ...flat(7, 160)];
    expect(recentVsBase(views(series)).pct).toBeCloseTo(60);

    const last28 = series.slice(-28);
    const prior28 = series.slice(-56, -28);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const mom = (mean(last28) / mean(prior28) - 1) * 100;
    expect(mom).toBeLessThan(THRESHOLDS.wikiSpikePct);
  });
});

describe('article resolution guard', () => {
  it('accepts the obvious match', () => {
    expect(articleMatchesCompany('Crocs, Inc.', 'Crocs')).toBe(true);
  });

  it('rejects a disambiguation page', () => {
    expect(articleMatchesCompany('Cava Group, Inc.', 'Cava (disambiguation)')).toBe(false);
  });

  it('rejects a plausible-looking wrong article', () => {
    // The live failure mode: the search returns its top hit and always
    // returns something, so an unguarded resolve attaches a person or a
    // product to a ticker and the series looks like real data.
    expect(articleMatchesCompany('Wingstop Inc.', 'Buffalo wing')).toBe(false);
  });

  it('treats a name with no distinguishing token as UNVERIFIABLE, not verified', () => {
    // "On Holding AG" reduces to nothing: "on" is two chars, "holding" and
    // "ag" are corporate boilerplate. Probed live, this name resolves to an
    // article averaging 0 views/day.
    expect(significantTokens('On Holding AG')).toEqual([]);
    expect(articleMatchesCompany('On Holding AG', 'On (company)')).toBe(false);
  });

  it('strips corporate boilerplate so it does not match on "inc"', () => {
    expect(articleMatchesCompany('Wingstop Inc.', 'Chipotle Mexican Grill Inc.')).toBe(false);
  });
});

describe('assessCandidate — a count of what moved, never a score', () => {
  it('counts one source per independent move', () => {
    const c = assessCandidate('CROX', 'Crocs Inc', {
      wikiSpikePct: 60,
      mentions: { state: 'TRACKED', rank: 400, spikePct: 400 },
      offExchangeZ: 1.8,
    });
    // Two convergence legs. The off-exchange reading is real and is reported,
    // but on the saturation side — it cannot add to the count.
    expect(c.convergence).toBe(2);
    expect(c.sourcesAvailable).toBe(2);
    expect(c.saturation.offExchangeZ).toBe(1.8);
  });

  it('does not let ONE source manufacture a strong reading on its own', () => {
    const c = assessCandidate('X', null, {
      wikiSpikePct: 900,
      mentions: { state: 'TRACKED', rank: 400, spikePct: 0 },
      offExchangeZ: 0,
    });
    expect(c.convergence).toBe(1);
    expect(c.sourcesAvailable).toBe(2);
  });

  it('never blends units and exposes no composite anywhere on the object', () => {
    const c = assessCandidate('X', null, {
      wikiSpikePct: 60,
      mentions: { state: 'TRACKED', rank: 400, spikePct: 400 },
      offExchangeZ: 1.8,
    });
    expect(new Set(c.observations.map((o) => o.unit))).toEqual(new Set(['%']));
    // The sd-unit reading still exists — it is just not an observation.
    expect(c.saturation.offExchangeZ).toBe(1.8);
    expect(c).not.toHaveProperty('score');
    expect(c).not.toHaveProperty('composite');
    expect(JSON.stringify(c)).not.toMatch(/"(score|composite|rank(ing)?Score)"/);
  });

  it('PRINTS the window each source was measured over', () => {
    // The honesty invariant. The two convergence legs are aligned on 7-vs-28
    // deliberately; anything measured on a different clock must say so rather
    // than be described as though it agreed with them.
    const c = assessCandidate('X', null, { wikiSpikePct: 60, offExchangeZ: 1.8 });
    for (const o of c.observations) expect(o.window).toBe('7d mean vs prior 28d mean');
  });

  it('does NOT count off-exchange volume toward convergence — it is a CROWDING gauge', () => {
    // shared/camillo-research.ts states this app's doctrine verbatim: "a
    // positive z means the crowd is already here, which argues AGAINST an
    // undiscovered setup." Counting it as evidence FOR a candidate put two
    // endpoints in one app on opposite sides of the same number. Measured on
    // the deploy preview before this was corrected, 4 of 7 candidates were
    // flagged SOLELY by a positive off-exchange z.
    const c = assessCandidate('X', null, { offExchangeZ: 2.5 });
    expect(c.observations.some((o) => (o.source as string) === 'offExchange')).toBe(false);
    expect(c.convergence).toBe(0);
    expect(c.saturation.offExchangeZ).toBe(2.5);
    expect(c.saturation.crowded).toBe(true);
    expect(c.saturation.reasons.join(' ')).toMatch(/retail is already trading it/);
  });

  it('a high off-exchange z can never on its own make a name a candidate', () => {
    expect(selectMoved([assessCandidate('X', null, { offExchangeZ: 9 })])).toEqual([]);
  });

  it('carries an unbounded rise through as MOVED and CHECKED', () => {
    const c = assessCandidate('X', null, {
      mentions: { state: 'TRACKED', rank: 400, spikePct: Number.POSITIVE_INFINITY },
    });
    const m = c.observations.find((o) => o.source === 'mentions')!;
    expect(m.unbounded).toBe(true);
    expect(m.moved).toBe(true);
    expect(m.checked).toBe(true);
    expect(m.value).toBeNull();
    expect(m.reason).toMatch(/zero baseline/);
    expect(c.convergence).toBe(1);
    expect(c.sourcesAvailable).toBe(1);
  });

  it('SURVIVES JSON SERIALISATION — the whole reason `unbounded` is a flag', () => {
    // JSON.stringify(Infinity) is null. If the unbounded case rode on the
    // numeric field, the loudest observation the tool can make would reach
    // the client as "no data" and be indistinguishable from a dead feed.
    const c = assessCandidate('X', null, {
      mentions: { state: 'TRACKED', rank: 400, spikePct: Number.POSITIVE_INFINITY },
    });
    const round: TrendCandidate = JSON.parse(JSON.stringify(c));
    const m = round.observations.find((o) => o.source === 'mentions')!;
    expect(m.moved).toBe(true);
    expect(m.unbounded).toBe(true);
    expect(m.checked).toBe(true);
    expect(round.convergence).toBe(1);
  });

  it('treats a missing source as UNCHECKED, never as a negative', () => {
    const c = assessCandidate('X', null, { wikiSpikePct: 60 });
    expect(c.convergence).toBe(1);
    expect(c.sourcesAvailable).toBe(1); // out of 1, not out of 2
    const m = c.observations.find((o) => o.source === 'mentions')!;
    expect(m.checked).toBe(false);
    expect(m.moved).toBe(false);
    expect(m.value).toBeNull();
    expect(m.reason).toMatch(/no recorded mention history/);
  });

  it('reports an unmeasured saturation gauge as null, not as "not crowded"', () => {
    const c = assessCandidate('X', null, { wikiSpikePct: 60 });
    expect(c.saturation.offExchangeZ).toBeNull();
    expect(c.saturation.reasons).toEqual([]);
  });

  it('says quiet is the EXPECTED state for an undiscovered name', () => {
    const c = assessCandidate('BROS', null, { mentions: { state: 'BELOW_FLOOR', rank: null } });
    expect(c.observations.find((o) => o.source === 'mentions')!.reason).toMatch(/expected state/);
  });

  it('surfaces the real reason a leg could not be measured', () => {
    const c = assessCandidate('X', null, { wikiSpikePct: null, wikiReason: 'resolved article "Buffalo wing" does not match' });
    expect(c.observations.find((o) => o.source === 'wikipedia')!.reason).toMatch(/does not match/);
  });

  it('requires an UP move — a collapse in attention is not a candidate', () => {
    const c = assessCandidate('X', null, {
      wikiSpikePct: -80,
      mentions: { state: 'TRACKED', rank: 400, spikePct: -50 },
    });
    expect(c.convergence).toBe(0);
    expect(c.sourcesAvailable).toBe(2); // measured, and measured as "no"
  });

  it('honours each threshold exactly at the boundary', () => {
    expect(assessCandidate('A', null, { wikiSpikePct: THRESHOLDS.wikiSpikePct }).convergence).toBe(1);
    expect(assessCandidate('B', null, { wikiSpikePct: THRESHOLDS.wikiSpikePct - 0.1 }).convergence).toBe(0);
    expect(assessCandidate('C', null, { offExchangeZ: SATURATION.offExchangeZ }).saturation.crowded).toBe(true);
    expect(assessCandidate('C2', null, { offExchangeZ: SATURATION.offExchangeZ - 0.01 }).saturation.crowded).toBe(false);
    expect(
      assessCandidate('D', null, { mentions: { state: 'TRACKED', rank: 9, spikePct: THRESHOLDS.mentionSpikePct } }).convergence,
    ).toBe(1);
  });
});

describe('saturation is reported, never netted', () => {
  it('a crowded name keeps its full convergence count', () => {
    const c = assessCandidate('GME', null, {
      wikiSpikePct: 60,
      mentions: { state: 'TRACKED', rank: 3, spikePct: 900 },
      offExchangeZ: 2.0,
    });
    // Three crowding gauges all firing, and the convergence count is
    // untouched by every one of them. That is the whole invariant.
    expect(c.convergence).toBe(2);
    expect(c.saturation.crowded).toBe(true);
    expect(c.saturation.reasons).toHaveLength(2); // loud rank + off-exchange
  });

  it('flags retail crowding by rank', () => {
    const c = assessCandidate('X', null, { mentions: { state: 'TRACKED', rank: SATURATION.loudRank - 1, spikePct: 400 } });
    expect(c.saturation.crowded).toBe(true);
    expect(c.saturation.note).toMatch(/the gap has closed/);
  });

  it('flags institutional crowding independently of chatter', () => {
    const c = assessCandidate('X', null, { wikiSpikePct: 60, context: { instOwnPct: 85 } });
    expect(c.saturation.crowded).toBe(true);
    expect(c.saturation.note).toMatch(/discovered by professionals/);
  });

  it('says uncrowded is consistent-with, never evidence-for', () => {
    const c = assessCandidate('X', null, { wikiSpikePct: 60, context: { instOwnPct: 20 } });
    expect(c.saturation.crowded).toBe(false);
    expect(c.saturation.note).toMatch(/not evidence for one/);
  });
});

describe('selectMoved — ALPHABETICAL, because ranking is pre-committed against', () => {
  const mk = (ticker: string, convergence: number, sourcesAvailable = 3): TrendCandidate =>
    assessCandidate(ticker, null, {
      wikiSpikePct: convergence >= 1 ? 60 : 0,
      mentions: { state: 'TRACKED', rank: 400, spikePct: convergence >= 2 ? 400 : 0 },
      offExchangeZ: convergence >= 3 ? 1.8 : (sourcesAvailable >= 3 ? 0 : null),
    });

  it('drops names where nothing moved', () => {
    expect(selectMoved([mk('A', 0), mk('B', 1)]).map((c) => c.ticker)).toEqual(['B']);
  });

  it('does NOT order by convergence — the strongest name does not float to the top', () => {
    // This is the gate test, and it is deliberately built so that a
    // convergence sort would pass a weaker version of it. ZZZ has three
    // sources moving and AAA has one; alphabetical still puts AAA first.
    // Re-introducing `sort((a,b) => b.convergence - a.convergence)` fails here.
    const out = selectMoved([mk('ZZZ', 3), mk('AAA', 1)]);
    expect(out.map((c) => c.ticker)).toEqual(['AAA', 'ZZZ']);
    expect(out[0].convergence).toBeLessThan(out[1].convergence);
  });

  it('does not order by sourcesAvailable either', () => {
    const out = selectMoved([mk('ZZZ', 1, 3), mk('AAA', 1, 1)]);
    expect(out.map((c) => c.ticker)).toEqual(['AAA', 'ZZZ']);
  });

  it('filters on minSources without reordering', () => {
    const out = selectMoved([mk('AAA', 1), mk('MMM', 3), mk('ZZZ', 2)], 2);
    expect(out.map((c) => c.ticker)).toEqual(['MMM', 'ZZZ']);
  });

  it('does NOT drop crowded names — a holder needs to see them', () => {
    const crowded = assessCandidate('ZLOUD', null, {
      wikiSpikePct: 60,
      mentions: { state: 'TRACKED', rank: 2, spikePct: 900 },
    });
    expect(crowded.saturation.crowded).toBe(true);
    expect(selectMoved([mk('AAA', 1), crowded]).map((c) => c.ticker)).toEqual(['AAA', 'ZLOUD']);
  });

  it('is deterministic and total', () => {
    expect(selectMoved([mk('ZZZ', 2), mk('AAA', 2), mk('MMM', 2)]).map((c) => c.ticker))
      .toEqual(['AAA', 'MMM', 'ZZZ']);
  });
});

describe('controlCohort — the comparison the study\'s gate demands', () => {
  const universe = Array.from({ length: 40 }, (_, i) => `T${String(i).padStart(2, '0')}`);
  const flagged = ['T00', 'T01', 'T02', 'T03', 'T04'];

  it('draws as many names as were flagged', () => {
    expect(controlCohort(universe, flagged, '2026-08-06:40:T00')).toHaveLength(flagged.length);
  });

  it('never includes a flagged name — otherwise it is not a control', () => {
    const c = controlCohort(universe, flagged, 'seed');
    expect(c.some((t) => flagged.includes(t))).toBe(false);
  });

  it('draws only from the scanned universe', () => {
    const c = controlCohort(universe, flagged, 'seed');
    expect(c.every((t) => universe.includes(t))).toBe(true);
  });

  it('is REPRODUCIBLE from the stored seed — a re-roll after the fact is the failure mode', () => {
    expect(controlCohort(universe, flagged, 'seed-A')).toEqual(controlCohort(universe, flagged, 'seed-A'));
  });

  it('actually depends on the seed', () => {
    expect(controlCohort(universe, flagged, 'seed-A')).not.toEqual(controlCohort(universe, flagged, 'seed-B'));
  });

  it('is not merely the alphabetical head of the universe', () => {
    const c = controlCohort(universe, flagged, 'seed-A');
    const head = universe.filter((t) => !flagged.includes(t)).slice(0, flagged.length);
    expect(c).not.toEqual(head);
  });

  it('degrades to what is left rather than throwing when the pool is small', () => {
    expect(controlCohort(['A', 'B', 'C'], ['A', 'B'], 's')).toHaveLength(1);
    expect(controlCohort(['A', 'B'], ['A', 'B'], 's')).toEqual([]);
  });
});

describe('mentionSeries — absence is the floor, not zero', () => {
  const snap = (date: string, mentions: number | null, floor: number): MentionSnapshot => ({
    date,
    filter: 'all-stocks',
    available: true,
    rows: mentions == null
      ? []
      : [{ ticker: 'CROX', name: 'Crocs', rank: 400, mentions, upvotes: null, mentions24hAgo: null, rank24hAgo: null }],
    floor,
    reason: null,
    fetchedAt: `${date}T21:10:00Z`,
  });

  it('returns the series oldest-first regardless of input order', () => {
    const out = mentionSeries('CROX', [snap('2026-08-03', 9, 1), snap('2026-08-01', 5, 1), snap('2026-08-02', 7, 1)]);
    expect(out).toEqual([5, 7, 9]);
  });

  it('uses the tracking FLOOR for a day the ticker was untracked, not 0', () => {
    // A name that dipped below tracking has mentions BELOW THE FLOOR, not
    // zero. Filling 0 would read as a total collapse in interest and would
    // manufacture a huge percentage move the day it came back.
    expect(mentionSeries('CROX', [snap('2026-08-01', null, 2)])).toEqual([2]);
  });

  it('is case-insensitive on the ticker', () => {
    expect(mentionSeries('crox', [snap('2026-08-01', 5, 1)])).toEqual([5]);
  });
});

describe('mentionSpikeOf', () => {
  it('refuses to answer on a short series', () => {
    expect(mentionSpikeOf(flat(MIN_MENTION_HISTORY_DAYS - 1, 10))).toBeNull();
  });

  it('measures growth off the recorded baseline', () => {
    expect(mentionSpikeOf([...flat(WINDOW.baseDays, 5), ...flat(WINDOW.recentDays, 15)])).toBeCloseTo(200);
  });

  it('does NOT apply the pageview baseline floor — a jump off the tracking floor is the signal', () => {
    // 1/day -> 30/day would be rejected by MIN_BASELINE_VIEWS. For mentions
    // it is precisely the event this leg exists to catch.
    expect(mentionSpikeOf([...flat(WINDOW.baseDays, 1), ...flat(WINDOW.recentDays, 30)])).toBeCloseTo(2900);
  });

  it('reports a rise off a zero baseline as unbounded', () => {
    expect(mentionSpikeOf([...flat(WINDOW.baseDays, 0), ...flat(WINDOW.recentDays, 40)]))
      .toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the contract refuses to imply edge', () => {
  it('the caveat states what this is and what it is not', () => {
    expect(DETECT_CAVEAT).toMatch(/CANDIDATE GENERATOR, not a signal/);
    expect(DETECT_CAVEAT).toMatch(/NOT RANKED/);
    expect(DETECT_CAVEAT).toMatch(/NO_EDGE/);
    expect(DETECT_CAVEAT).toMatch(/pre-committed gate/);
    expect(DETECT_CAVEAT).toMatch(/random control cohort/);
    expect(DETECT_CAVEAT).toMatch(/OWN window/);
  });

  it('thresholds and windows are explicit constants a reader can argue with', () => {
    expect(THRESHOLDS.wikiSpikePct).toBe(25);
    expect(THRESHOLDS.mentionSpikePct).toBe(100);
    expect(SATURATION.offExchangeZ).toBe(1.0);
    expect(WINDOW).toEqual({ recentDays: 7, baseDays: 28 });
    expect(MIN_MENTION_HISTORY_DAYS).toBe(35);
  });
});

// APP RATINGS — the "what consumers DO" leg. The trend study's own conclusion
// is that do-signals do not reverse while look-at signals do, and until this
// existed every leg here was look-at. `appRatingSnapshots` had been recording
// the data daily since the cron went live with NOTHING reading it back.
describe('appRatingSpikeOf — cumulative counts must be differenced first', () => {
  const cum = (deltas: number[], start = 10_000) => {
    const out = [start];
    for (const d of deltas) out.push(out[out.length - 1] + d);
    return out;
  };

  it('measures growth in NEW ratings per day, not in the lifetime total', () => {
    // THE TRAP: Apple's count is lifetime cumulative. Comparing levels would
    // report a fraction of a percent forever — a live feed that reads dead.
    const series = cum([...new Array(WINDOW.baseDays).fill(100), ...new Array(WINDOW.recentDays).fill(300)]);
    expect(appRatingSpikeOf(series)).toBeCloseTo(200);

    // The same series compared as LEVELS moves by ~2%, which would never clear
    // the 40% bar no matter how hard the app was actually growing.
    const need = WINDOW.recentDays + WINDOW.baseDays;
    const lvlRecent = series.slice(-WINDOW.recentDays).reduce((a, b) => a + b, 0) / WINDOW.recentDays;
    const lvlBase = series.slice(-need, -WINDOW.recentDays).reduce((a, b) => a + b, 0) / WINDOW.baseDays;
    expect((lvlRecent / lvlBase - 1) * 100).toBeLessThan(THRESHOLDS.appRatingSpikePct);
  });

  it('needs one MORE observation than the mention leg — N deltas need N+1 points', () => {
    expect(MIN_APP_HISTORY_DAYS).toBe(MIN_MENTION_HISTORY_DAYS + 1);
    expect(appRatingSpikeOf(cum(new Array(MIN_MENTION_HISTORY_DAYS - 1).fill(100)))).toBeNull();
    expect(appRatingSpikeOf(cum(new Array(MIN_MENTION_HISTORY_DAYS).fill(100)))).not.toBeNull();
  });

  it('treats a FALLING lifetime count as a broken series, not as collapsing demand', () => {
    // A lifetime total cannot fall. It means the app identity changed under us
    // — a re-listing, a different appId matched. Averaging across that break
    // invents a demand collapse and then an explosion the day after.
    const series = cum(new Array(MIN_MENTION_HISTORY_DAYS).fill(100));
    series[20] = 0;
    expect(appRatingSpikeOf(series)).toBeNull();
  });

  it('reports a rise off a zero baseline as unbounded, like the other legs', () => {
    const series = cum([...new Array(WINDOW.baseDays).fill(0), ...new Array(WINDOW.recentDays).fill(50)]);
    expect(appRatingSpikeOf(series)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is quiet, not moved, when the flow is flat', () => {
    expect(appRatingSpikeOf(cum(new Array(MIN_MENTION_HISTORY_DAYS).fill(100)))).toBeCloseTo(0);
  });
});

describe('appRatingSeries', () => {
  const day = (date: string, rows: Array<[string, number | null]>) => ({
    date,
    rows: rows.map(([ticker, ratingCount]) => ({ ticker, appId: 1, appName: 'a', rating: 4.5, ratingCount })),
  });

  it('reads one ticker out of the daily rows, oldest first', () => {
    expect(appRatingSeries('CROX', [
      day('2026-08-01', [['CROX', 100], ['EAT', 5]]),
      day('2026-08-02', [['CROX', 140], ['EAT', 6]]),
    ])).toEqual([100, 140]);
  });

  it('SKIPS days with no HIGH-confidence match rather than filling a zero', () => {
    // A day the app could not be matched is a missing observation. A zero
    // would difference into a catastrophic negative and break the series.
    expect(appRatingSeries('CROX', [
      day('2026-08-01', [['CROX', 100]]),
      day('2026-08-02', [['EAT', 6]]),
      day('2026-08-03', [['CROX', 140]]),
    ])).toEqual([100, 140]);
  });

  it('is case-insensitive and tolerates a null count', () => {
    expect(appRatingSeries('crox', [day('2026-08-01', [['CROX', null]]), day('2026-08-02', [['CROX', 7]])]))
      .toEqual([7]);
  });
});

describe('the app leg is a first-class convergence source', () => {
  it('counts toward convergence and reports its own window', () => {
    const c = assessCandidate('CROX', 'Crocs', { appRatingSpikePct: 90 });
    const a = c.observations.find((o) => o.source === 'appRatings')!;
    expect(a.moved).toBe(true);
    expect(a.checked).toBe(true);
    expect(a.window).toBe('7d mean vs prior 28d mean');
    expect(c.convergence).toBe(1);
  });

  it('honours its own threshold, which is lower than chatter on purpose', () => {
    expect(THRESHOLDS.appRatingSpikePct).toBe(40);
    expect(THRESHOLDS.appRatingSpikePct).toBeLessThan(THRESHOLDS.mentionSpikePct);
    expect(assessCandidate('A', null, { appRatingSpikePct: 40 }).convergence).toBe(1);
    expect(assessCandidate('B', null, { appRatingSpikePct: 39.9 }).convergence).toBe(0);
  });

  it('is UNCHECKED, not negative, when there is no recorded history', () => {
    const c = assessCandidate('X', null, { wikiSpikePct: 60 });
    const a = c.observations.find((o) => o.source === 'appRatings')!;
    expect(a.checked).toBe(false);
    expect(a.moved).toBe(false);
    expect(a.reason).toMatch(/no recorded app-rating history/);
  });

  it('lets all three legs converge', () => {
    const c = assessCandidate('CROX', 'Crocs', {
      wikiSpikePct: 60,
      mentions: { state: 'TRACKED', rank: 400, spikePct: 400 },
      appRatingSpikePct: 90,
    });
    expect(c.convergence).toBe(3);
    expect(c.sourcesAvailable).toBe(3);
  });
});
