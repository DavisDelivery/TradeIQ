// PROFILE-1 W3.2 — the coverage gate.
//
// The defect this exists to prevent: a metric row shipped without a `key`,
// which silently made it unclickable. There was no failing test for that,
// because "renders a value" passes whether or not the row can be opened.
// Six rows sat un-openable that way, and the panel looked finished.
//
// So the rule is now mechanical rather than remembered: every metric key any
// surface offers must resolve in the direction table, every policy must carry
// a definition, and every metric must have exactly one reason for its rank —
// present, unpooled, or not-rankable. Never two, never none.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { METRIC_POLICY, policyFor } from '../metric-direction';
import { NO_PEER_POOL, NOT_RANKABLE } from '../peer-stats';
import { canPoolMetric } from '../peer-pool';

const SRC = join(__dirname, '../../../../src/components/detail');

/** Pull every `key: 'x'` a panel offers the drawer. */
function keysOfferedBy(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  return [...text.matchAll(/\bkey:\s*'([A-Za-z0-9]+)'/g)].map((m) => m[1]);
}

const PANELS = ['KeyMetricsPanel.jsx', 'OwnershipPanel.jsx', 'TradabilityStrip.jsx'];

describe('every key a panel offers resolves in the direction table', () => {
  for (const panel of PANELS) {
    it(`${panel} offers only known metrics`, () => {
      const keys = keysOfferedBy(panel);
      expect(keys.length).toBeGreaterThan(0);
      const unknown = keys.filter((k) => policyFor(k) === null);
      expect(unknown).toEqual([]);
    });
  }

  it('the panels together cover a real spread, not one token row', () => {
    const all = new Set(PANELS.flatMap(keysOfferedBy));
    // Guards against a future edit deleting keys wholesale and still passing.
    expect(all.size).toBeGreaterThanOrEqual(28);
  });
});

describe('every row on the three panels is clickable', () => {
  // The regression itself: a row with a label and no key.
  for (const panel of PANELS) {
    it(`${panel} has no row that renders a value without a key`, () => {
      const text = readFileSync(join(SRC, panel), 'utf8');
      // Scanned by LINE, not by brace matching: a cell whose value is a
      // template literal (`$${fmtNum(t.atr)}`) contains a closing brace, so a
      // `[^}]*\}` pattern truncates the row and reports a false positive.
      // Every row/cell literal in these panels is one per line.
      const rows = text.split('\n').filter((l) => /\blabel:\s*'/.test(l));
      expect(rows.length).toBeGreaterThan(0);
      const keyless = rows.filter((r) => !/\bkey:\s*'/.test(r));
      expect(keyless).toEqual([]);
    });
  }
});

describe('every policy carries a definition', () => {
  it('meaning is present and is a real sentence', () => {
    for (const [key, p] of Object.entries(METRIC_POLICY)) {
      expect(p.meaning, `${key} has no meaning`).toBeTruthy();
      // Long enough to be an explanation rather than a restated label.
      expect(p.meaning.length, `${key} meaning too short`).toBeGreaterThan(30);
      expect(p.meaning.trim().endsWith('.'), `${key} meaning is not a sentence`).toBe(true);
    }
  });

  it('a definition never just repeats the label', () => {
    for (const [key, p] of Object.entries(METRIC_POLICY)) {
      expect(p.meaning.toLowerCase().trim()).not.toBe(p.label.toLowerCase().trim());
    }
  });
});

describe('exactly one rank outcome per metric', () => {
  it('no metric is both unpooled and not-rankable', () => {
    const both = [...NOT_RANKABLE].filter((k) => NO_PEER_POOL.has(k));
    expect(both).toEqual([]);
  });

  it('every offered key has a resolvable outcome', () => {
    const offered = [...new Set(PANELS.flatMap(keysOfferedBy))];
    for (const k of offered) {
      const outcomes = [
        NOT_RANKABLE.has(k),
        NO_PEER_POOL.has(k),
        canPoolMetric(k),
      ].filter(Boolean).length;
      // Pooled-and-listed-as-unpooled would make the endpoint's order of
      // checks the only thing deciding what the reader sees.
      expect(outcomes, `${k} has ${outcomes} outcomes, expected exactly 1`).toBe(1);
    }
  });

  it('a not-rankable metric points at its comparable form', () => {
    // Otherwise "no rank for this" is a dead end rather than a redirection.
    for (const k of ['longTermDebt', 'freeCashFlow', 'atr']) {
      const p = policyFor(k);
      expect(p?.showBeside?.length, `${k} should point somewhere`).toBeGreaterThan(0);
      for (const target of p!.showBeside!) {
        expect(policyFor(target), `${k} points at unknown ${target}`).not.toBeNull();
      }
    }
  });
});
