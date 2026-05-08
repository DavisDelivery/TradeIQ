// Shared small visual components used across views.
//
// Logo, StatusDot, ConvictionBadge, DirectionPill — each is small and used
// in 3+ places. Keeping them here means each view file stays focused on
// its own behavior.

import React from 'react';
import { tierColor, directionIcon } from '../lib/formatters.jsx';

export const Logo = ({ appVersion }) => (
  <div className="flex items-center gap-3">
    <div className="relative">
      <div className="h-9 w-9 border border-emerald-500/30 bg-emerald-500/5 flex items-center justify-center">
        <div className="text-emerald-400 font-serif font-bold text-xs tracking-tight">α</div>
      </div>
      <div className="absolute -top-1 -right-1 h-1.5 w-1.5 bg-emerald-400 rounded-full animate-pulse" />
    </div>
    <div className="leading-tight">
      <div className="font-serif font-bold text-base tracking-[-0.01em]">
        TradeIQ <span className="text-emerald-400 italic font-light">Alpha</span>
      </div>
      <div className="text-[10px] text-neutral-500 font-mono tracking-wider uppercase mt-0.5">
        multi-factor · {appVersion}
      </div>
    </div>
  </div>
);

export const StatusDot = ({ status = 'healthy' }) => {
  const color = status === 'healthy' ? 'bg-emerald-400' : status === 'warning' ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="relative h-1.5 w-1.5 flex items-center justify-center">
      <div className={`h-1.5 w-1.5 ${color} rounded-full`} />
      <div className={`absolute h-1.5 w-1.5 ${color} rounded-full animate-ping opacity-50`} />
    </div>
  );
};

export const ConvictionBadge = ({ tier }) => (
  <div className="inline-flex items-center gap-1.5">
    <div
      className="h-5 w-5 flex items-center justify-center text-[10px] font-bold font-mono border"
      style={{ color: tierColor(tier), borderColor: tierColor(tier) + '66', background: tierColor(tier) + '15' }}
    >
      {tier}
    </div>
  </div>
);

export const DirectionPill = ({ direction }) => {
  const cls = direction === 'long'
    ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
    : direction === 'short'
    ? 'text-rose-300 border-rose-500/30 bg-rose-500/10'
    : 'text-neutral-300 border-neutral-700 bg-neutral-900';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${cls}`}>
      {directionIcon(direction)}
      {direction}
    </span>
  );
};
