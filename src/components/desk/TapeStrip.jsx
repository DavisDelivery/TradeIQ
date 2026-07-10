// DESK-1 W2 — market tape: SPY QQQ IWM DIA via the existing quotes
// endpoint on a 15s cadence (paused when the tab is hidden — TanStack
// focusManager + refetchIntervalInBackground:false), plus the regime
// pill with the gross-exposure band label.
//
// HONESTY RULE: each cell renders the snapshot timestamp alongside the
// quote. The tape never claims "real-time" — Polygon plan data is
// delayed, and the stamp says exactly what the user is looking at.

import React from 'react';
import { useLiveQuotes } from '../../hooks/useLiveQuotes.js';

export const TAPE_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA'];

// Gross-exposure band per regime — the Desk's standing sizing bands.
// Label only (no order routing here); derived client-side from the
// regime classification.
export const EXPOSURE_BANDS = {
  risk_on: { label: '80–100% gross', cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' },
  neutral: { label: '40–70% gross', cls: 'text-neutral-300 border-neutral-600 bg-neutral-800/60' },
  risk_off: { label: '0–30% gross', cls: 'text-rose-400 border-rose-500/40 bg-rose-500/10' },
};

function ageLabel(asOf, updatedAt) {
  const t = asOf ? Date.parse(asOf) : updatedAt;
  if (!t || !Number.isFinite(t)) return null;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  return new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function TapeStrip({ regime, enabled = true }) {
  const { quotesByTicker, quotesAsOf, dataUpdatedAt } = useLiveQuotes(TAPE_TICKERS, {
    refetchIntervalMs: 15_000,
    enabled,
  });
  const age = ageLabel(quotesAsOf, dataUpdatedAt);
  const regimeKey = regime?.regime ?? 'neutral';
  const band = EXPOSURE_BANDS[regimeKey] ?? EXPOSURE_BANDS.neutral;

  return (
    <div
      data-testid="desk-tape"
      className="flex items-center gap-4 h-9 px-3 border-b border-neutral-800/80 bg-[#090a0c] overflow-x-auto scrollbar-hide whitespace-nowrap font-mono text-[11px]"
    >
      {TAPE_TICKERS.map((t) => {
        const q = quotesByTicker[t];
        const pct = q?.changePct;
        const signed = typeof pct === 'number' && Number.isFinite(pct);
        return (
          <div key={t} className="flex items-baseline gap-1.5 flex-shrink-0" data-testid={`tape-${t}`}>
            <span className="text-neutral-500 uppercase tracking-wider">{t}</span>
            <span className="text-neutral-200 tabular-nums">
              {q?.price != null ? q.price.toFixed(2) : '—'}
            </span>
            <span className={`tabular-nums ${!signed ? 'text-neutral-600' : pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {signed ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
            </span>
          </div>
        );
      })}

      <span className="text-neutral-800">│</span>

      {/* Regime pill + gross-exposure band */}
      <div className="flex items-center gap-1.5 flex-shrink-0" data-testid="desk-regime-pill">
        <span
          className={`inline-flex items-center border px-1.5 py-0.5 text-[9px] uppercase tracking-widest ${
            regimeKey === 'risk_on'
              ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
              : regimeKey === 'risk_off'
                ? 'text-rose-400 border-rose-500/40 bg-rose-500/10'
                : 'text-neutral-300 border-neutral-600 bg-neutral-800/60'
          }`}
        >
          {regimeKey.replace(/_/g, ' ')}
        </span>
        <span className={`inline-flex items-center border px-1.5 py-0.5 text-[9px] uppercase tracking-widest ${band.cls}`}>
          {band.label}
        </span>
      </div>

      {/* Quote-age stamp — honest about delay, never "real-time" */}
      <div className="ml-auto flex-shrink-0 text-[9px] uppercase tracking-widest text-neutral-600" data-testid="tape-age">
        {age ? `quotes ${age}` : 'quotes —'}
      </div>
    </div>
  );
}
