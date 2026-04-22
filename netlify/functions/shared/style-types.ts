// Re-export for style analysts that were written with a fuller AnalystScore shape.
// Adapter in target-board will convert to the v1 AnalystOutput used by the frontend.

export interface AnalystScore {
  analyst: string;
  score: number; // -100 to +100 (style score)
  confidence: number;
  rationale: string;
  signals: Record<string, any>;
}
