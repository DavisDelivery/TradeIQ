import React from 'react';
import { Shield } from 'lucide-react';
import { StatusDot } from './components/Badges.jsx';

export const RegimeView = ({ regime }) => {
  if (!regime || !regime.regime) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Regime data unavailable.
        </div>
      </div>
    );
  }

  const regimeLabel = (regime.regime ?? 'neutral').replace(/_/g, ' ');

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Macro Regime</div>
        <h1 className="font-serif text-3xl font-bold tracking-tight">
          <span className={regime.regime === 'risk_on' ? 'text-emerald-400' : regime.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'}>
            {regimeLabel}
          </span>
          <span className="text-neutral-500 italic font-light ml-3">({regime.conviction ?? 'unknown'} conviction)</span>
        </h1>
        <p className="text-neutral-400 mt-2 max-w-3xl">{regime.rationale}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="border border-neutral-800 p-5">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">VIX</div>
            {/* Backend volRegime enum is 'low' | 'medium' | 'high'
                (shared/regime.ts) — code-review-2026-06 M4. */}
            <StatusDot status={regime.vol?.regime === 'high' ? 'danger' : regime.vol?.regime === 'medium' ? 'warning' : 'healthy'} />
          </div>
          <div className="font-mono text-4xl font-semibold text-neutral-100 mt-2">{regime.vol?.level?.toFixed(1)}</div>
          <div className="mt-2 text-[11px] font-mono text-neutral-500 uppercase tracking-widest">
            {regime.vol?.regime} · {regime.vol?.trend} · p{regime.vol?.percentile}
          </div>
          {/* No sparkline: the regime payload carries only the current VIX
              level, and the repo's honest-no-data rule forbids fabricating a
              series (code-review-2026-06 m7 removed a Math.random() chart). */}
        </div>

        <div className="border border-neutral-800 p-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">10Y Yield</div>
          <div className="font-mono text-4xl font-semibold text-neutral-100 mt-2">{regime.rates?.tenYear?.toFixed(2)}<span className="text-neutral-500 text-xl">%</span></div>
          <div className="mt-2 text-[11px] font-mono text-neutral-500 uppercase tracking-widest">{regime.rates?.trend}</div>
          <div className="mt-4 pt-3 border-t border-neutral-800/80">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">2y10y Spread</span>
              <span className="font-mono text-sm text-neutral-200">{regime.rates?.twoTenSpread}bp</span>
            </div>
            <div className={`text-[10px] font-mono mt-1 uppercase tracking-wider ${
              regime.rates?.curveRegime === 'inverted' ? 'text-rose-400' : regime.rates?.curveRegime === 'steep' ? 'text-emerald-400' : 'text-neutral-500'
            }`}>
              {regime.rates?.curveRegime}
            </div>
          </div>
        </div>

        <div className="border border-neutral-800 p-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Risk Appetite</div>
          <div className="mt-3 space-y-3">
            <div>
              <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">SPY / TLT Trend</div>
              <div className={`text-sm mt-1 ${
                regime.riskAppetite?.ratioTrend === 'risk_on_rising' ? 'text-emerald-400' :
                regime.riskAppetite?.ratioTrend === 'risk_off_rising' ? 'text-rose-400' : 'text-neutral-300'
              }`}>
                {regime.riskAppetite?.ratioTrend?.replace(/_/g, ' ')}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">Credit Signal</div>
              <div className={`text-sm mt-1 ${
                regime.riskAppetite?.creditSignal === 'tightening_spreads' ? 'text-emerald-400' :
                regime.riskAppetite?.creditSignal === 'widening_spreads' ? 'text-rose-400' : 'text-neutral-300'
              }`}>
                {regime.riskAppetite?.creditSignal?.replace(/_/g, ' ')}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Multipliers panel */}
      <div className="border border-neutral-800 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Signal Multipliers</div>
            <h3 className="font-serif text-lg mt-1">How this regime adjusts each signal type</h3>
          </div>
          <Shield className="h-5 w-5 text-neutral-500" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label: 'Bullish Technical', value: regime.regime === 'risk_on' ? 1.15 : regime.regime === 'risk_off' ? 0.80 : 1.0 },
            { label: 'Bearish Technical', value: regime.regime === 'risk_on' ? 0.85 : regime.regime === 'risk_off' ? 1.20 : 1.0 },
            { label: 'Positive News', value: regime.regime === 'risk_on' ? 1.10 : regime.regime === 'risk_off' ? 0.85 : 1.0 },
            { label: 'Negative News', value: regime.regime === 'risk_on' ? 0.85 : regime.regime === 'risk_off' ? 1.15 : 1.0 },
            // Premium multipliers keyed on the REAL backend enum
            // ('low' | 'medium' | 'high'); 'high' takes the old dead
            // 'elevated' branch's behavior (M4).
            { label: 'Earnings Sell Premium', value: regime.vol?.regime === 'high' ? 1.15 : regime.vol?.regime === 'low' ? 0.90 : 1.0 },
            { label: 'Earnings Buy Premium', value: regime.vol?.regime === 'low' ? 1.15 : regime.vol?.regime === 'high' ? 0.85 : 1.0 },
          ].map(m => {
            const above = m.value > 1.0;
            const below = m.value < 1.0;
            return (
              <div key={m.label} className="flex items-center justify-between py-2 px-3 border border-neutral-800/60 bg-neutral-950/40">
                <span className="text-[12px] text-neutral-300">{m.label}</span>
                <span className={`font-mono text-sm ${above ? 'text-emerald-400' : below ? 'text-rose-400' : 'text-neutral-400'}`}>
                  ×{m.value.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
