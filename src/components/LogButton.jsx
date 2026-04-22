import React, { useState, useEffect } from 'react';
import { readLog, logTrade } from '../tradeLog.js';

// Build a stable identity for "this is the same logged trade as before"
// so we can show "already logged" state. For earnings we include reportDate.
function entryMatches(entry, payload) {
  if (entry.ticker !== payload.ticker) return false;
  if (entry.source !== payload.source) return false;
  if (payload.source === 'earnings' && payload.reportDate) {
    return entry.reportDate === payload.reportDate;
  }
  // Same ticker + source within last 24h = already logged
  const ageHours = (Date.now() - new Date(entry.loggedAt).getTime()) / 3_600_000;
  return ageHours < 24;
}

export const LogButton = ({ payload, size = 'sm', className = '' }) => {
  const [logged, setLogged] = useState(false);

  useEffect(() => {
    const recheck = () => {
      const existing = readLog().some((e) => entryMatches(e, payload));
      setLogged(existing);
    };
    recheck();
    window.addEventListener('tradelog:change', recheck);
    return () => window.removeEventListener('tradelog:change', recheck);
  }, [payload.ticker, payload.source, payload.reportDate]);

  const handleClick = (ev) => {
    ev.stopPropagation();
    if (logged) return;
    logTrade(payload);
    setLogged(true);
  };

  const sizeClass = size === 'xs'
    ? 'px-1.5 py-0.5 text-[9px]'
    : size === 'md'
      ? 'px-3 py-1.5 text-[12px]'
      : 'px-2 py-1 text-[10px]';

  return (
    <button
      onClick={handleClick}
      disabled={logged}
      title={logged ? 'Already in Journal' : 'Add to Journal — tracks 5/20/30/60/90-day returns'}
      className={`${sizeClass} font-mono uppercase tracking-widest border transition-colors ${
        logged
          ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/15 cursor-default'
          : 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/15'
      } ${className}`}
    >
      {logged ? '✓ Logged' : '+ Log'}
    </button>
  );
};
