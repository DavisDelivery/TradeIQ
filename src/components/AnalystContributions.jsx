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
//
// Phase 4q — each contribution row is now an inline accordion. Tapping
// expands it to show the analyst's `rationale` + a legible rendering
// of its `signals`. Detail is fetched on demand via the
// /api/target-rationale endpoint (session-memoized per ticker) so the
// board snapshot stays lean (Phase 4u doc-size lesson). No-data
// analysts render greyed + italic — visibly distinct from a real
// neutral score.

import React, { useState } from 'react';
import { Circle, ChevronDown, ChevronRight } from 'lucide-react';
import { analystIcon, analystLabel } from '../lib/formatters.jsx';
import { useTargetRationale } from '../hooks/useTargetRationale.js';

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

// ---------------------------------------------------------------------------
// Phase 4q — signals rendering. The signals object's contents vary by
// analyst (numbers, strings, booleans, occasional nested objects /
// arrays). The goal is "legible key/value detail, not raw JSON". We
// strip the _noData / _reason markers (rendered separately), camelCase
// → "Camel Case", and format primitives sensibly. Nested values fall
// back to JSON.stringify so unusual signals still show SOMETHING
// rather than blanking.
// ---------------------------------------------------------------------------
function humanizeKey(key) {
  return key
    .replace(/_/g, ' ')
    // camelCase boundary: lower/digit → Upper
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatSignalValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return value.slice(0, 5).join(', ') + (value.length > 5 ? ` (+${value.length - 5})` : '');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function visibleSignalEntries(signals) {
  if (!signals || typeof signals !== 'object') return [];
  return Object.entries(signals).filter(([k]) => !k.startsWith('_'));
}

// ---------------------------------------------------------------------------
// Phase 4q — single accordion row. Header is the existing CONTRIBUTIONS
// row (icon · label · badge · score bar · weight). Tapping toggles the
// inline expansion below it. The expanded body renders:
//   - the analyst's rationale text
//   - either a key/value signals table (real analyst) OR a greyed
//     italic "No actionable data — <reason>" line (signals._noData)
// We render the header as a <button> so keyboard / screen-reader users
// can activate it; aria-expanded toggles for assistive tech.
// ---------------------------------------------------------------------------
function AnalystRow({ contribution, status, detail, detailLoading, detailError }) {
  const [open, setOpen] = useState(false);
  const c = contribution;
  const Icon = analystIcon[c.analyst] || Circle;
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

  // Permanently-removed analysts have no detail to expand — they were
  // pulled from the weight table entirely, so there's no rationale +
  // signals payload behind them. Render the row as non-interactive.
  const expandable = status !== 'removed';
  const Chevron = open ? ChevronDown : ChevronRight;

  // The detail (rationale + signals) comes from the W1 endpoint via
  // the parent's useTargetRationale lookup. detail.signals._noData ===
  // true is the explicit "no actionable data" path. We also fall back
  // to the row's own NO DATA status (from target.noDataAnalysts) so
  // the greyed/italic state shows even before the detail load resolves.
  const detailNoData = !!(detail && detail.signals && detail.signals._noData === true);
  const isNoData = status === 'no_data' || detailNoData;
  const noDataReason =
    detail && detail.signals && typeof detail.signals._reason === 'string'
      ? detail.signals._reason
      : 'no_data';

  return (
    <div data-testid={`analyst-row-${c.analyst}`}>
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? `analyst-detail-${c.analyst}` : undefined}
        disabled={!expandable}
        className={`w-full flex items-center gap-3 text-left ${rowOpacity} ${
          expandable ? 'hover:bg-neutral-900/50 focus:outline-none focus:bg-neutral-900/50' : 'cursor-default'
        } px-1 -mx-1 py-0.5`}
      >
        {expandable ? (
          <Chevron className="h-3 w-3 text-neutral-500 shrink-0" />
        ) : (
          <span className="inline-block h-3 w-3 shrink-0" />
        )}
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
      </button>

      {expandable && open && (
        <div
          id={`analyst-detail-${c.analyst}`}
          className={`ml-7 mt-1 mb-2 pl-3 border-l border-neutral-800 text-[11px] font-mono ${
            isNoData ? 'opacity-60' : ''
          }`}
        >
          {detailLoading && !detail && (
            <div className="text-neutral-500 italic">Loading reasoning…</div>
          )}
          {detailError && !detail && (
            <div className="text-rose-400">Could not load reasoning: {detailError}</div>
          )}
          {(detail || (!detailLoading && !detailError)) && (
            <>
              {isNoData ? (
                <div className="text-neutral-400 italic">
                  No actionable data — {noDataReason}
                </div>
              ) : (
                detail?.rationale && (
                  <div className="text-neutral-300 leading-relaxed">{detail.rationale}</div>
                )
              )}

              {!isNoData && detail && visibleSignalEntries(detail.signals).length > 0 && (
                <div className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                  {visibleSignalEntries(detail.signals).map(([k, v]) => (
                    <React.Fragment key={k}>
                      <div className="text-neutral-500 uppercase tracking-wider text-[10px] self-center">
                        {humanizeKey(k)}
                      </div>
                      <div className="text-neutral-200 break-all">{formatSignalValue(v)}</div>
                    </React.Fragment>
                  ))}
                </div>
              )}

              {!detail && !detailLoading && !detailError && (
                <div className="text-neutral-500 italic">No reasoning available.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AnalystContributions({ target }) {
  // Phase 4q — hook fires from the panel; rows pull their per-analyst
  // detail out of the resulting map. Per React-Hooks rules we cannot
  // skip this call when target is null; the hook gates fetch on
  // `enabled: !!target?.ticker`, so a null target just sits idle.
  const ticker = target?.ticker;
  const { data, isLoading, error } = useTargetRationale(ticker, {
    enabled: !!ticker,
  });

  if (!target?.analystContributions) return null;
  const scoredAnalysts = target.scoredAnalysts ?? [];
  const noDataAnalysts = target.noDataAnalysts ?? [];

  const detailByAnalyst = new Map();
  if (data && Array.isArray(data.analysts)) {
    for (const row of data.analysts) detailByAnalyst.set(row.analyst, row);
  }

  return (
    <div className="border border-neutral-800 p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">
        Contributions
      </div>
      <div className="space-y-1">
        {target.analystContributions.map((c) => {
          const status = provenanceFor(c.analyst, scoredAnalysts, noDataAnalysts);
          const detail = detailByAnalyst.get(c.analyst) ?? null;
          return (
            <AnalystRow
              key={c.analyst}
              contribution={c}
              status={status}
              detail={detail}
              detailLoading={isLoading && status !== 'removed'}
              detailError={error?.message ?? null}
            />
          );
        })}
      </div>
    </div>
  );
}

// Exported for tests
export const _internals = { PERMANENTLY_REMOVED, BADGE_CONFIG, humanizeKey, formatSignalValue, visibleSignalEntries };
