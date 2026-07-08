// FIX-1 W4 — the measured-edge chip.
//
// Rendered on EVERY board header (Williams / Lynch / Prophet / Target)
// and inside every AI thesis / research-brief render. The chip is the
// registry speaking (netlify/functions/shared/verdicts.ts — pure data,
// imported directly by both runtimes); prose never outranks it.
// Narrative confidence ≠ measured edge.

import React from 'react';
import { BOARD_VERDICTS, verdictLabel } from '../../netlify/functions/shared/verdicts';

const STATUS_STYLES = {
  NO_EDGE: 'border-rose-500/50 bg-rose-500/10 text-rose-300',
  MIXED: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  PENDING: 'border-neutral-600 bg-neutral-800/60 text-neutral-400',
  VALIDATED: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
};

/**
 * @param {{ board: 'williams'|'lynch'|'prophet'|'target', compact?: boolean }} props
 * `compact` drops the label to the bare status for tight inline spots
 * (thesis headers); the full measured numbers stay in the tooltip.
 */
export function VerdictChip({ board, compact = false }) {
  const v = BOARD_VERDICTS[board];
  if (!v) return null;
  const label = verdictLabel(v);
  const title = [
    label,
    `Window: ${v.window}`,
    v.runId ? `Run: ${v.runId}` : null,
    v.date ? `As of ${v.date}` : null,
    v.note,
  ]
    .filter(Boolean)
    .join('\n');
  const text = compact
    ? v.status === 'NO_EDGE'
      ? 'NO EDGE'
      : v.status === 'PENDING'
        ? 'PENDING'
        : v.status
    : label;
  return (
    <span
      data-testid={`verdict-chip-${board}`}
      title={title}
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest whitespace-nowrap align-middle ${
        STATUS_STYLES[v.status] ?? STATUS_STYLES.PENDING
      }`}
    >
      {text}
    </span>
  );
}
