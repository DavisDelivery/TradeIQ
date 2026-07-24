import React, { useState } from 'react';
import { Zap, Check, AlertTriangle } from 'lucide-react';
import { logTrade } from '../tradeLog.js';

// "I just made this trade" — one-tap execution logging (Chad's ask,
// 2026-07-23). Tap → pick Buy/Sell (+ optional share count) → Log. The
// price is fetched LIVE at the moment of logging (/api/quotes, the same
// feed the boards overlay), and logTrade stamps loggedAt at call time —
// so the journal entry records what you actually did, when you actually
// did it, at the price the market was actually showing. Entries land in
// the Journal under the "My Trades" filter with full forward-return
// tracking vs SPY.
export function TradeTakenButton({ ticker, className = '' }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState('buy');
  const [shares, setShares] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // {price, at} after a successful log
  const [error, setError] = useState(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/quotes?tickers=${encodeURIComponent(ticker)}`);
      const json = await r.json().catch(() => ({}));
      const q = json?.quotes?.[ticker] ?? json?.quotes?.[ticker?.toUpperCase()];
      const price = Number(q?.price);
      if (!Number.isFinite(price)) {
        setError('no live price right now — try again in a moment');
        setBusy(false);
        return;
      }
      const n = Number(shares);
      const entry = logTrade({
        ticker,
        source: 'trade',
        side,
        shares: Number.isFinite(n) && n > 0 ? n : null,
        loggedPrice: price,
        note: `logged live at tap (${side.toUpperCase()}${Number.isFinite(n) && n > 0 ? ` ${n} sh` : ''})`,
      });
      setDone({ price, at: entry.loggedAt });
      setOpen(false);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className={`flex items-center gap-2 px-3 py-2 border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[11px] font-mono ${className}`} data-testid="trade-taken-done">
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        Logged {side.toUpperCase()} {ticker} @ ${done.price.toFixed(2)} ·{' '}
        {new Date(done.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — in your Journal
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="trade-taken-open"
        className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-emerald-500/40 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/15 transition-colors text-[11px] font-mono uppercase tracking-widest ${className}`}
      >
        <Zap className="h-3.5 w-3.5" />
        I just made this trade — log it @ live price
      </button>
    );
  }

  return (
    <div className={`border border-emerald-500/30 bg-neutral-950/60 p-2.5 space-y-2 ${className}`} data-testid="trade-taken-form">
      <div className="flex items-center gap-1.5 flex-wrap">
        {['buy', 'sell'].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`px-3 h-8 text-[11px] font-mono uppercase tracking-widest border transition-colors ${
              side === s
                ? s === 'buy'
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                  : 'bg-rose-500/15 text-rose-300 border-rose-500/40'
                : 'text-neutral-500 border-neutral-800 hover:border-neutral-600'
            }`}
          >
            {s}
          </button>
        ))}
        <input
          type="number"
          inputMode="decimal"
          min="0"
          placeholder="shares (opt)"
          value={shares}
          onChange={(e) => setShares(e.target.value)}
          className="w-28 h-8 px-2 bg-transparent border border-neutral-800 focus:border-neutral-600 outline-none text-[12px] text-neutral-100 placeholder:text-neutral-600 font-mono"
        />
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          data-testid="trade-taken-confirm"
          className="ml-auto px-3 h-8 text-[11px] font-mono uppercase tracking-widest border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
        >
          {busy ? 'fetching…' : 'Log @ live'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="px-2 h-8 text-[11px] font-mono text-neutral-500 hover:text-neutral-200"
        >
          ✕
        </button>
      </div>
      <div className="text-[10px] text-neutral-500 font-mono">
        Price + timestamp are captured the moment you tap Log — nothing is backdated.
      </div>
      {error && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-amber-300">
          <AlertTriangle className="h-3 w-3" /> {error}
        </div>
      )}
    </div>
  );
}

export default TradeTakenButton;
