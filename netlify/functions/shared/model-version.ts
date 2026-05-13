// Model version stamp.
//
// Every snapshot written by Phase 1 carries this version. Phase 4 backtest
// and Phase 5 calibration filter snapshots by version so historical replay
// stays comparable across scoring changes.
//
// BUMP THIS on any change that affects scoring math, layer weights, layer
// thresholds, the analyst battery composition, or how composite scores are
// computed. Do NOT bump for UI changes, refactors, or bug fixes that don't
// alter scores.
//
// Format: YYYY.NN.minor
//   YYYY  — calendar year of the bump
//   NN    — sequential within that year (01, 02, ...)
//   minor — patch within that NN, when needed

export const MODEL_VERSION = '2026.02.0';
