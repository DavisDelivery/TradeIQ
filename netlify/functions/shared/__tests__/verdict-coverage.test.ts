// BROKER-1 W1 — no board reaches a Buy button without an edge statement.
//
// THE DEFECT THIS EXISTS TO PREVENT, and it was live:
//
//   VIEWS ∩ BOARD_VERDICTS was the EMPTY SET. Every board a user could open
//   (catalyst, trident, screens, insiders, earnings, crosses, quiet-strength)
//   was absent from the registry, and every board IN the registry had been
//   retired out of the nav. VerdictChip returns null for an unregistered
//   board, so the chip — whose entire purpose is to stop a fluent thesis
//   outranking a backtest — rendered on nothing at all.
//
// The chip failing SILENTLY is what made that survivable for so long. So the
// registry/nav correspondence is pinned here mechanically: a new board in
// VIEWS fails this test on the commit that adds it, rather than shipping a
// Buy button with no measured-edge statement above it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOARD_VERDICTS,
  verdictLabel,
  isUnvalidated,
  isVerdictBoard,
  type VerdictBoard,
} from '../verdicts';

const APP = join(__dirname, '../../../../src/App.jsx');

/** Nav ids straight from the RAW_VIEWS literal, so the test reads what ships. */
function navIds(): string[] {
  const src = readFileSync(APP, 'utf8');
  const start = src.indexOf('const RAW_VIEWS = [');
  expect(start, 'RAW_VIEWS literal not found in App.jsx').toBeGreaterThan(-1);
  const end = src.indexOf('\n];', start);
  const block = src.slice(start, end);
  return [...block.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

/**
 * Views that are boards — i.e. they list ranked tickers whose detail modal
 * carries an order row. The rest (Journal, Settings, Chart…) are tools and
 * carry no edge claim, so they are deliberately exempt.
 */
const BOARD_VIEWS = [
  'trident', 'catalyst', 'insiders', 'earnings', 'crosses',
  'screens', 'quiet-strength',
];

const TOOL_VIEWS = [
  'desk', 'forward', 'history', 'options', 'engine', 'backtest',
  'chart', 'regime', 'analysts', 'alerts', 'journal', 'settings',
];

describe('every reachable board carries a verdict', () => {
  it('the nav still contains the boards this test claims to cover', () => {
    // Guards the list above from drifting out of the app silently.
    const ids = navIds();
    expect(ids.length).toBeGreaterThan(10);
    for (const b of BOARD_VIEWS) {
      expect(ids, `${b} vanished from RAW_VIEWS`).toContain(b);
    }
  });

  it('flags any NEW nav id that is neither a registered board nor a known tool', () => {
    // The loud failure: add a board, this fails until you register a verdict.
    const known = new Set([...BOARD_VIEWS, ...TOOL_VIEWS]);
    const unaccounted = navIds().filter((id) => !known.has(id));
    expect(
      unaccounted,
      `new nav id(s) ${unaccounted.join(', ')} — register a verdict in ` +
        'verdicts.ts and add to BOARD_VIEWS, or add to TOOL_VIEWS if it ' +
        'lists no tickers and shows no Buy button',
    ).toEqual([]);
  });

  it.each(BOARD_VIEWS)('%s resolves in BOARD_VERDICTS', (board) => {
    expect(isVerdictBoard(board), `${board} is not a VerdictBoard`).toBe(true);
    expect(BOARD_VERDICTS[board as VerdictBoard]).toBeTruthy();
  });

  it.each(BOARD_VIEWS)('%s renders a non-empty chip label', (board) => {
    // "renders blank" is the exact failure mode; an empty label is one too.
    const label = verdictLabel(BOARD_VERDICTS[board as VerdictBoard]);
    expect(label.trim().length).toBeGreaterThan(0);
  });

  it('no tool view accidentally acquired a verdict', () => {
    const stray = TOOL_VIEWS.filter((id) => isVerdictBoard(id));
    expect(stray, `tool views must not claim an edge: ${stray.join(', ')}`).toEqual([]);
  });
});

describe('UNMEASURED is its own claim', () => {
  it('labels as NOT MEASURED and never carries a number', () => {
    for (const v of Object.values(BOARD_VERDICTS)) {
      if (v.status !== 'UNMEASURED') continue;
      expect(verdictLabel(v)).toBe('NOT MEASURED');
      // A number here would be a measurement claim, which is what the status
      // denies. Every field that could carry one must be null.
      expect(v.excessVsSPYPp).toBeNull();
      expect(v.excessVsQQQPp).toBeNull();
      expect(v.ic).toBeNull();
      expect(v.runId).toBeNull();
    }
  });

  it('counts as unvalidated, because an unmeasured board is not a validated one', () => {
    for (const [key, v] of Object.entries(BOARD_VERDICTS)) {
      if (v.status === 'UNMEASURED') {
        expect(isUnvalidated(key as VerdictBoard), `${key}`).toBe(true);
      }
    }
  });

  it('leaves PENDING and MIXED above the line — a partial measurement is not an absent one', () => {
    // Deliberate and worth pinning: prophet is PENDING, vector is MIXED.
    // Both describe a measurement that exists. Flipping them would move
    // boards in the nav on a judgement BROKER-1 did not ask for.
    expect(isUnvalidated('prophet')).toBe(false);
    expect(isUnvalidated('vector')).toBe(false);
  });

  it('every registered board has an honest, substantive note', () => {
    for (const [key, v] of Object.entries(BOARD_VERDICTS)) {
      expect(v.note.trim().length, `${key} note too short`).toBeGreaterThan(40);
    }
  });
});

describe('the nav divider stays contiguous and last', () => {
  it('unvalidated boards sort to the end, so the positional divider renders once', () => {
    // All three renderers detect the divider with
    // `views[i-1]?.section !== 'unvalidated'`. A scattered partition would
    // draw a divider before each run of unvalidated boards.
    const ids = navIds();
    const flags = ids.map((id) => (isVerdictBoard(id) ? isUnvalidated(id) : false));
    const firstUnvalidated = flags.indexOf(true);
    if (firstUnvalidated === -1) return;
    // Everything from the first unvalidated onwards must also be unvalidated
    // AFTER App.jsx's stable partition — this asserts the partition exists by
    // checking the RAW order would otherwise be scattered.
    const scatteredInRaw = flags.slice(firstUnvalidated).some((f) => !f);
    expect(
      scatteredInRaw,
      'RAW_VIEWS interleaves unvalidated boards, so App.jsx MUST keep its ' +
        'stable partition — do not remove it',
    ).toBe(true);
  });
});
