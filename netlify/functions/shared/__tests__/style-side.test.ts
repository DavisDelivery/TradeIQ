// Wave 4C (code-review-2026-06 track-1, m6) — honest side labels.
//
// `side = score >= 0 ? 'long' : 'short'` labeled a 0 score (typically
// "no data / nothing scoreable") as a LONG candidate on the Lynch and
// Williams boards. sideFromScore maps 0 → 'neutral'; board endpoints
// filter on exact 'long'/'short' matches so neutral rows only surface
// under side=both.

import { describe, expect, it } from 'vitest';
import { sideFromScore } from '../style-types';

describe('sideFromScore (m6)', () => {
  it('labels positive scores long', () => {
    expect(sideFromScore(0.1)).toBe('long');
    expect(sideFromScore(85)).toBe('long');
  });

  it('labels negative scores short', () => {
    expect(sideFromScore(-0.1)).toBe('short');
    expect(sideFromScore(-40)).toBe('short');
  });

  it('labels a zero (no-data) score neutral — NOT long', () => {
    expect(sideFromScore(0)).toBe('neutral');
  });
});
