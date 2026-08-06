// TICKER-1 (2026-08-06) — one clickable ticker primitive for the whole app.
//
// THE PROBLEM THIS REPLACES.
// "Any ticker anywhere opens the company profile" has been asked for
// repeatedly and fixed piecemeal each time, because opening a profile used to
// require the SURROUNDING VIEW to cooperate: hold `selected` state, render a
// MasterDetail or a TickerDetailModal, and thread an `onOpenTicker` callback
// down to wherever the symbol was drawn. Every new panel started life unable
// to do that, so every new panel shipped with dead tickers, and the fix was
// always local. The Forward Test pick log is the case that made this obvious:
// the ticker there WAS a button, but a 40px-wide one in a dense card, with no
// affordance saying so — indistinguishable from the dead ones.
//
// So the capability no longer belongs to the view. A provider at the app root
// owns the state and renders exactly one modal; `<Ticker>` reaches it through
// context. A component that renders a symbol needs no state, no modal, no
// props threaded from its parent, and cannot be wired up wrong — the only way
// to draw a ticker is the way that works.
//
// Deliberate details:
//   - Without a provider it degrades to plain text rather than throwing, so a
//     unit test rendering a panel in isolation still works.
//   - It is a <button>, so it is keyboard-reachable and screen-reader
//     announced, and it carries a visible underline affordance because an
//     invisible tap target is the same as no tap target.
//   - `stopPropagation` on click: tickers frequently sit inside rows that are
//     themselves clickable, and opening the profile must not also fire the
//     row's own select.

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { TickerDetailModal } from './detail/TickerDetailModal.jsx';

const TickerDetailContext = createContext(null);

/**
 * Mount once, at the app root. Owns the single profile overlay.
 */
export function TickerDetailProvider({ children }) {
  const [target, setTarget] = useState(null); // { ticker, row, board }

  const openTicker = useCallback((ticker, opts = {}) => {
    const symbol = String(ticker ?? '').trim().toUpperCase();
    if (!symbol) return;
    setTarget({ ticker: symbol, row: opts.row ?? null, board: opts.board ?? 'search' });
  }, []);

  const value = useMemo(() => ({ openTicker }), [openTicker]);

  return (
    <TickerDetailContext.Provider value={value}>
      {children}
      {target && (
        <TickerDetailModal
          ticker={target.ticker}
          row={target.row}
          board={target.board}
          onClose={() => setTarget(null)}
        />
      )}
    </TickerDetailContext.Provider>
  );
}

/**
 * Imperative access, for the cases where the click target is not the symbol
 * itself — a whole table row, a chart legend entry, a card.
 *
 * Returns a no-op opener when there is no provider, so callers never need to
 * null-check before wiring an onClick.
 */
export function useTickerDetail() {
  const ctx = useContext(TickerDetailContext);
  return ctx ?? { openTicker: () => {} };
}

/**
 * A ticker symbol that opens the company profile.
 *
 * @param symbol   the ticker; falsy renders an em-dash rather than an empty
 *                 clickable box, matching the app's "missing is not zero" rule
 * @param row      optional board row, passed through so the profile can show
 *                 board-specific context without refetching
 * @param board    which board's lens to open the profile with
 * @param as       'span' keeps inline flow inside sentences; default is a
 *                 button-styled inline element
 */
export function Ticker({
  symbol,
  row = null,
  board = 'search',
  className = '',
  children,
  onOpen,
  ...rest
}) {
  const { openTicker } = useTickerDetail();
  const label = String(symbol ?? '').trim();
  if (!label) return <span className="text-neutral-600">—</span>;

  return (
    <button
      type="button"
      data-testid={`ticker-link-${label.toUpperCase()}`}
      data-ticker={label.toUpperCase()}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onOpen?.(label);
        openTicker(label, { row, board });
      }}
      title={`Open ${label.toUpperCase()} profile`}
      className={
        'inline underline decoration-dotted decoration-neutral-600 underline-offset-2 ' +
        'hover:text-emerald-400 hover:decoration-emerald-400 focus-visible:outline-none ' +
        'focus-visible:ring-1 focus-visible:ring-emerald-400 transition-colors cursor-pointer ' +
        className
      }
      {...rest}
    >
      {children ?? label}
    </button>
  );
}
