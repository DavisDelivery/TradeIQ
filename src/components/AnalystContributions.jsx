// Phase 4f W5 — Analyst contributions panel with provenance badges.
//
// Shows each analyst's contribution to the composite, with a
// LIVE / NO DATA / REMOVED badge indicating whether the analyst
// produced a real signal (LIVE), was skipped this snapshot for
// lack of upstream data (NO DATA), or has been permanently removed
// from the weight table (REMOVED).
//
// The REMOVED list mirrors `ANALYST_WEIGHTS` entries whose weight is
// 0 in `netlify/functions/shared/analyst-runner.ts`. Keep these
// two in sync. The audit doc (`reports/phase-4f/audit.md` § 2)
// documents the rationale per removed analyst.

import React from 'react';
import { Circle } from 'lucide-react';
import { analystIcon, analystLabel } from '../lib/formatters.jsx';

const PERMANENTLY_REMOVED = new Set(['macro-regime', 'patent-analyst']);

const BADGE_CONFIG = {
  live:    { label: 'LIVE',    cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  no_data: { label: 'NO DATA', cls: 'text-neutral-500 bg-neutral-500/10 border-neutral-500/20' },
  removed: { label: 'REMOVED', cls: 'text-neutral-600 bg-neutral-700/10 border-neutral-700/30' },
};

export function StatusBadge({ status }) {
  const cfg = BADGE_CONFIG[status];
  if (!cfg) return null;
  return (
    <span className={`px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

export function provenanceFor(analystName, scoredAnalysts, noDataAnalysts) {
  if (PERMANENTLY_REMOVED.has(analystName)) return 'removed';
  if (Array.isArray(noDataAnalysts) && noDataAnalysts.includes(analystName)) return 'no_data';
  return 'live';
}

export function AnalystContributions({ target }) {
  if (!target?.analystContributions) return null;
  const scoredAnalysts = target.scoredAnalysts ?? [];
  const noDataAnalysts = target.noDataAnalysts ?? [];
  return (
    <div className="border border-neutral-800 p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">
        Contributions
      </div>
      <div className="space-y-2">
        {target.analystContributions.map((c) => {
          const Icon = analystIcon[c.analyst] || Circle;
          const status = provenanceFor(c.analyst, scoredAnalysts, noDataAnalysts);
          const color =
            c.direction === 'long' ? 'text-emerald-400'
            : c.direction === 'short' ? 'text-rose-400'
            : 'text-neutral-400';
          const fill =
            c.direction === 'long' ? '#14e89a'
            : c.direction === 'short' ? '#ff5577'
            : '#9ca3af';
          const label = analystLabel[c.analyst] ?? c.analyst;
          const rowOpacity = status === 'live' ? '' : 'opacity-70';
          const labelCls = status === 'removed' ? 'line-through text-neutral-500' : 'text-neutral-300';
          return (
            <div key={c.analyst} className={`flex items-center gap-3 ${rowOpacity}`}>
              <Icon className={`h-3.5 w-3.5 ${color}`} />
              <div className={`flex-1 text-[12px] font-mono ${labelCls}`}>{label}</div>
              <StatusBadge status={status} />
              <div className="flex items-center gap-2 flex-1">
                <div className="flex-1 h-1 bg-neutral-800">
                  <div
                    className="h-full"
                    style={{ width: `${status === 'removed' ? 0 : c.score}%`, background: fill }}
                  />
                </div>
                <span className={`font-mono text-[12px] w-8 text-right ${color}`}>
                  {status === 'removed' ? '—' : c.score}
                </span>
              </div>
              <span className="font-mono text-[10px] text-neutral-500 w-10 text-right uppercase">
                {Number.isFinite(c.weight) ? `${(c.weight * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Exported for tests
export const _internals = { PERMANENTLY_REMOVED, BADGE_CONFIG };
