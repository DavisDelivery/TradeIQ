import React from 'react';
import { AlertTriangle, Brain } from 'lucide-react';
import { analystIcon } from './lib/formatters.jsx';
import { StatusDot } from './components/Badges.jsx';

export const AnalystsView = ({ analysts }) => (
  <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
    <div className="mb-6">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Signal Producers</div>
      <h1 className="font-serif text-3xl font-bold tracking-tight">
        {analysts.length} <span className="text-neutral-500 italic font-light">analysts running</span>
      </h1>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {analysts.map(a => {
        const Icon = analystIcon[a.name] || Brain;
        return (
          <div key={a.name} className="border border-neutral-800 p-5 hover:border-neutral-700 transition-colors">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 border border-neutral-800 flex items-center justify-center bg-neutral-900/60">
                  <Icon className="h-4 w-4 text-neutral-400" />
                </div>
                <div>
                  <div className="font-serif text-lg">{a.label}</div>
                  <div className="font-mono text-[11px] text-neutral-500 uppercase tracking-wider mt-0.5">{a.name}</div>
                </div>
              </div>
              <StatusDot status={a.status} />
            </div>

            <div className="mt-4 grid grid-cols-3 gap-4 pt-4 border-t border-neutral-800/60">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">Signals 24h</div>
                <div className="font-mono text-lg text-neutral-100 mt-1">{Number.isFinite(a.signalsToday) ? a.signalsToday : '—'}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">Accuracy 7d</div>
                <div className={`font-mono text-lg mt-1 ${
                  !Number.isFinite(a.accuracy7d) ? 'text-neutral-600' :
                  a.accuracy7d >= 0.65 ? 'text-emerald-400' :
                  a.accuracy7d >= 0.55 ? 'text-sky-400' : 'text-amber-400'
                }`}>
                  {Number.isFinite(a.accuracy7d) ? `${(a.accuracy7d * 100).toFixed(0)}%` : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">Cost 24h</div>
                {/* analysts-status hardcodes cost:0 (no measurement layer yet) —
                    a confident $0.00 misreads as a measurement; render — until
                    a real producer writes it (audit 2026-07-15). */}
                <div className="font-mono text-lg text-neutral-100 mt-1">{Number.isFinite(a.cost) && a.cost > 0 ? `$${a.cost.toFixed(2)}` : '—'}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>

    <div className="mt-6 border border-neutral-800 p-5 bg-amber-500/5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-serif text-base text-neutral-200">Accuracy metrics are provisional</div>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            Accuracy is measured as: of signals that were tier-A or tier-B at time of firing, what fraction were in-the-money
            10 trading days later (≥2% for long signals, ≤-2% for short). Need 100+ closed observations per analyst before
            weights are tuned. Current sample is small — treat numbers as directional, not definitive.
          </p>
        </div>
      </div>
    </div>
  </div>
);
