import React from 'react';
import { Globe2 } from 'lucide-react';

export const UNIVERSE_OPTIONS = [
  { id: 'all', label: 'All', short: 'All' },
  { id: 'sp500', label: 'S&P 500', short: 'S&P' },
  { id: 'ndx', label: 'Nasdaq 100', short: 'NDX' },
  { id: 'dow', label: 'Dow 30', short: 'Dow' },
  { id: 'russell2k', label: 'Russell 2K', short: 'R2K' },
];

export const UniverseSelector = ({ universe, setUniverse, compact = false }) => {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] text-neutral-500 uppercase tracking-wider shrink-0">
        <Globe2 className="h-3 w-3" />
        <span className="hidden sm:inline">Universe</span>
      </div>
      <div className="flex flex-wrap gap-1 min-w-0">
        {UNIVERSE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setUniverse(opt.id)}
            className={`px-2.5 py-1 text-[11px] font-medium border transition-colors flex-shrink-0 ${
              universe === opt.id
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
            }`}
          >
            {compact ? opt.short : opt.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export const UNIVERSE_AWARE_VIEWS = new Set([
  'board', 'catalyst', 'williams', 'lynch', 'earnings', 'options',
]);
