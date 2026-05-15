// Phase 4f W3+W5 — Composite-weight rescaling for no-data analysts.
//
// Pure helper. Used by analyst-runner.ts (Target Board composite) and
// will eventually be used by prophet-layers.ts when Prophet layer
// repairs land. The rescaling rule:
//
//   For each analyst with `noData: true`, drop its weight from the
//   composite and redistribute the freed weight proportionally across
//   the remaining "live" analysts so the survivor weights still sum
//   to 1.0.
//
// This is the brief's W3/W5 math (kickoff § 4.5). The shape returned
// is consumed by the Target composite math + the UI badge layer.

export interface ComposeWeightsInput {
  /** Map of analyst name → noData flag (true if the analyst has no
   *  data to score; will be excluded from the composite). */
  noDataByAnalyst: Record<string, boolean>;
  /** Map of analyst name → baseline weight; baseline weights should
   *  sum to 1.0, but we don't assume so — we renormalize from the
   *  live subset. */
  baseWeights: Record<string, number>;
}

export interface ComposeWeightsResult {
  /** Effective weight per analyst — 0 for no-data analysts; live
   *  analysts get a proportionally-rescaled share that sums to 1.0. */
  effectiveWeights: Record<string, number>;
  /** Names of analysts whose scores contributed to the composite. */
  scoredAnalysts: string[];
  /** Names of analysts excluded as no-data. */
  noDataAnalysts: string[];
  /** True iff at least one analyst was excluded — useful for UI
   *  hints + telemetry. */
  rescaled: boolean;
}

export function composeWeights(
  input: ComposeWeightsInput,
): ComposeWeightsResult {
  const { noDataByAnalyst, baseWeights } = input;
  const scoredAnalysts: string[] = [];
  const noDataAnalysts: string[] = [];
  let liveWeightSum = 0;
  for (const [name, w] of Object.entries(baseWeights)) {
    if (noDataByAnalyst[name]) {
      noDataAnalysts.push(name);
    } else {
      scoredAnalysts.push(name);
      liveWeightSum += w;
    }
  }
  const effectiveWeights: Record<string, number> = {};
  for (const name of Object.keys(baseWeights)) {
    if (noDataByAnalyst[name]) {
      effectiveWeights[name] = 0;
    } else if (liveWeightSum > 0) {
      effectiveWeights[name] = baseWeights[name] / liveWeightSum;
    } else {
      // Every analyst is no-data. Equal-weight the survivors (which
      // is empty) — return 0s. Caller decides what to do with an
      // all-empty composite (likely emit a "not scoreable" Target).
      effectiveWeights[name] = 0;
    }
  }
  return {
    effectiveWeights,
    scoredAnalysts,
    noDataAnalysts,
    rescaled: noDataAnalysts.length > 0,
  };
}

/**
 * Convenience for the UI badge layer: classify each analyst as
 * 'live' | 'no_data' | 'removed' given the rescale result + an
 * optional list of permanently removed names (e.g. ones whose data
 * is unrecoverable per W2 classification). 'no_data' is transient
 * (this scoring call); 'removed' is structural.
 */
export type AnalystProvenance = 'live' | 'no_data' | 'removed';

export function provenanceFor(
  analystName: string,
  rescale: ComposeWeightsResult,
  permanentlyRemoved: Set<string> = new Set(),
): AnalystProvenance {
  if (permanentlyRemoved.has(analystName)) return 'removed';
  if (rescale.noDataAnalysts.includes(analystName)) return 'no_data';
  return 'live';
}
