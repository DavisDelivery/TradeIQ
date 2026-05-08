// FreshnessPill — small top-right indicator showing where a board's data came
// from (snapshot vs. live partial scan), how old it is, and a force-rescan
// button. Used by every board view as part of Phase 1.
//
// Props:
//   meta — the API response object. We pull source, ageMs, generatedAt,
//          modelVersion, warning from it.
//   isRescanning — true while a force rescan request is in flight.
//   onForceRescan — handler called when the user taps "Force rescan".

import React from 'react';
import { RefreshCw } from 'lucide-react';

function formatAge(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return null;
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function FreshnessPill({ meta, isRescanning = false, onForceRescan }) {
  const source = meta?.source;
  const ageMs = meta?.ageMs;
  const ageLabel = formatAge(ageMs);

  let color = 'text-neutral-500 border-neutral-700 bg-neutral-950/40';
  let label = '—';
  let title = 'No source info';

  if (source === 'snapshot') {
    color = 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5';
    label = ageLabel ? `Live · ${ageLabel}` : 'Live';
    title = `Served from snapshot${meta?.modelVersion ? ' · model ' + meta.modelVersion : ''}${
      meta?.generatedAt ? ' · ' + meta.generatedAt : ''
    }`;
  } else if (source === 'forced-partial') {
    color = 'text-amber-400 border-amber-500/40 bg-amber-500/5';
    label = 'Forced · partial';
    title = 'Force-rescan ran a capped partial scan; ignored snapshot';
  } else if (source === 'fallback-partial') {
    color = 'text-red-400 border-red-500/40 bg-red-500/5';
    label = 'Fallback · partial';
    title =
      meta?.warning ||
      'Snapshot stale or missing — partial scan served. Full coverage returns after next scheduled run.';
  } else if (source === 'error') {
    color = 'text-red-400 border-red-500/40 bg-red-500/5';
    label = 'Error';
    title = meta?.error || 'Scan failed';
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className={`px-2 py-1 text-[11px] font-medium border tracking-wide uppercase ${color}`}
        title={title}
      >
        {label}
      </span>
      {onForceRescan && (
        <button
          onClick={onForceRescan}
          disabled={isRescanning}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Run a fresh capped scan, ignoring snapshot"
        >
          <RefreshCw className={`h-3 w-3 ${isRescanning ? 'animate-spin' : ''}`} />
          {isRescanning ? 'Scanning…' : 'Force rescan'}
        </button>
      )}
    </div>
  );
}
