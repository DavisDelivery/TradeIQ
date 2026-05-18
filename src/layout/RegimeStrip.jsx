// Phase 4k W1 — regime ticker strip (extracted for reuse).
//
// The same regime row that has lived inside the mobile TopBar since
// pre-4k. Extracted here so the desktop shell can render it without
// duplicating JSX. Mobile TopBar continues to import + render it
// untouched, so the mobile DOM stays byte-identical.

import React from 'react';
import { Clock } from 'lucide-react';
import { StatusDot } from '../components/Badges.jsx';

export function RegimeStrip({ regime, universeStats }) {
  const regimeLabel = (regime?.regime ?? 'neutral').replace(/_/g, ' ').toUpperCase();
  return (
    <div className="h-8 bg-[#090a0c] text-[11px] font-mono overflow-x-auto scrollbar-hide">
      <div className="flex items-center h-full gap-3 sm:gap-6 px-3 sm:px-6 text-neutral-400 whitespace-nowrap min-w-max">
        <div className="flex items-center gap-2">
          <StatusDot status={regime?.regime === 'risk_off' ? 'warning' : 'healthy'} />
          <span className="uppercase tracking-wider">Regime</span>
          <span className={`font-medium ${
            regime?.regime === 'risk_on' ? 'text-emerald-400' :
            regime?.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'
          }`}>
            {regimeLabel}
          </span>
        </div>
        <span className="text-neutral-700">│</span>
        <div>VIX <span className="text-neutral-200">{regime?.vol?.level?.toFixed(1) ?? '—'}</span></div>
        <span className="text-neutral-700">│</span>
        <div>10Y <span className="text-neutral-200">{regime?.rates?.tenYear?.toFixed(2) ?? '—'}%</span></div>
        <span className="text-neutral-700">│</span>
        <div>2Y10Y <span className="text-neutral-200">{regime?.rates?.twoTenSpread ?? '—'}bp</span> <span className="text-neutral-500">{regime?.rates?.curveRegime ?? ''}</span></div>
        <span className="text-neutral-700">│</span>
        <div>
          <span className="uppercase tracking-wider">Universe</span>
          <span className="text-neutral-200 ml-1.5">{universeStats?.core || 0}</span>
          <span className="text-neutral-500 ml-1">core</span>
          {universeStats?.watchlist > 0 && (
            <>
              <span className="text-neutral-200 ml-2">{universeStats.watchlist}</span>
              <span className="text-neutral-500 ml-1">watch</span>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 text-neutral-500">
          <Clock className="h-3 w-3" />
          <span>
            {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} ET
          </span>
        </div>
      </div>
    </div>
  );
}
