import { describe, expect, it } from 'vitest';
import {
  DETECT_CAVEAT,
  MIN_BASELINE_VIEWS,
  MIN_MENTION_HISTORY_DAYS,
  SATURATION,
  THRESHOLDS,
  WINDOW,
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
    expect(c.convergence).toBe(3);
    expect(c.sourcesAvailable).toBe(3);
  });

  it('does not let ONE source manufacture a strong reading on its own', () => {
    const c = assessCandidate('X', null, {
      wikiSpikePct: 900,
      mentions: { state: 'TRACKED', rank: 400, spikePct: 0 },
      offExchangeZ: 0,
    });
    expect(c.convergence).toBe(1);
    expect(c.sourcesAvailable).toBe(3);
  });

  it('never blends units and exposes no composite anywhere on the object', () => {
    const c = assessCandidate('X', null, {
      wikiSpikePct: 60,
      mentions: { state: 'TRACKED', rank: 400, spikePct: 400 },
      offExchangeZ: 1.8,
    });
    expect(new Set(c.observations.map((o) => o.unit))).toEqual(new Set(['%', 'sd']));
    expect(c).not.toHaveProperty('score');
    expect(c).not.toHaveProperty('composite');
    expect(JSON.stringify(c)).not.toMatch(/"(score|composite|rank(ing)?Score)"/);
  });

  it('PRINTS each source\'s real window, and they are not all the same', () => {
    // The honesty invariant. Off-exchange is fixed at 5d-vs-60d inside
    // quiver-offexchange.ts. Three sources on three clocks have not "agreed
    // about an event", and the payload must not let anyone claim they did.
    const c = assessCandidate('X', null, { wikiSpikePct: 60, offExchangeZ: 1.8 });
    const wiki = c.observations.find((o) => o.source === 'wikipedia')!;
    const oe = c.observations.find((o) => o.source === 'offExchange')!;
    expect(wiki.window).toBe('7d mean vs prior 28d mean');
    expect(oe.window).toMatch(/5d mean vs prior 60d/);
    expect(oe.window).not.toBe(wiki.window);
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
    expect(c.sourcesAvailable).toBe(1); // out of 1, not out of 3
    const oe = c.observations.find((o) => o.source === 'offExchange')!;
    expect(oe.checked).toBe(false);
    expect(oe.moved).toBe(false);
    expect(oe.value).toBeNull();
    expect(oe.reason).toMatch(/not enough/);
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
    const c = assessCandidate('X', null, { wikiSpikePct: -80, offExchangeZ: -2.4 });
    expect(c.convergence).toBe(0);
    expect(c.sourcesAvailable).toBe(2); // measured, and measured as "no"
  });

  it('honours each threshold exactly at the boundary', () => {
    expect(assessCandidate('A', null, { wikiSpikePct: THRESHOLDS.wikiSpikePct }).convergence).toBe(1);
    expect(assessCandidate('B', null, { wikiSpikePct: THRESHOLDS.wikiSpikePct - 0.1 }).convergence).toBe(0);
    expect(assessCandidate('C', null, { offExchangeZ: THRESHOLDS.offExchangeZ }).convergence).toBe(1);
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
    expect(c.convergence).toBe(3);
    expect(c.saturation.crowded).toBe(true);
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
    expect(THRESHOLDS.offExchangeZ).toBe(1.0);
    expect(WINDOW).toEqual({ recentDays: 7, baseDays: 28 });
    expect(MIN_MENTION_HISTORY_DAYS).toBe(35);
  });
});
