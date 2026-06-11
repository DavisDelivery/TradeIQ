// Re-export for style analysts that were written with a fuller AnalystScore shape.
// Adapter in target-board will convert to the v1 AnalystOutput used by the frontend.

export interface AnalystScore {
  analyst: string;
  score: number; // -100 to +100 (style score)
  confidence: number;
  rationale: string;
  signals: Record<string, any>;
}

/** Candidate side derived from a signed style score. */
export type StyleSide = 'long' | 'short' | 'neutral';

/**
 * Honest side label for a signed style score (Wave 4C, review m6).
 * The old `score >= 0 ? 'long' : 'short'` ternary labeled a 0 score —
 * typically "no data / no setup" — as a long candidate. A 0 is neither:
 * it maps to 'neutral'. Board endpoints filter on exact 'long'/'short'
 * matches, so neutral rows only surface under side=both, and the History
 * view prints the raw value — no consumer needs a special case.
 */
export function sideFromScore(score: number): StyleSide {
  if (score > 0) return 'long';
  if (score < 0) return 'short';
  return 'neutral';
}
