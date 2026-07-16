import React, { useState } from 'react';
import { ShoppingCart, Check } from 'lucide-react';
import { OrderTicket } from './OrderTicket.jsx';

// Entry buttons for the full order ticket. Buy/Sell open the OrderTicket
// (all order types + shares-owned + stop-loss); it places a REAL Robinhood
// order via broker-execute. If Robinhood isn't connected the server returns
// a clear "connect first" surfaced in the ticket.

export function OrderButtons({ ticker, sourceBoard, price, rationale, sellable = true, className = '' }) {
  const [mode, setMode] = useState('idle'); // idle | ticket | done
  const [side, setSide] = useState('buy');
  const [done, setDone] = useState(null);

  if (mode === 'done' && done) {
    const o = done.order || {};
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border text-emerald-300 border-emerald-500/40 bg-emerald-500/10 ${className}`}>
        <Check className="h-3 w-3" /> {o.orderType || ''} {o.side} {o.qty} @ ${o.price}{done.stopOrder ? ` · stop $${done.stopOrder.stopPrice}` : ''}
      </span>
    );
  }
  if (mode === 'ticket') {
    return (
      <OrderTicket
        ticker={ticker} sourceBoard={sourceBoard} price={price} rationale={rationale} initialSide={side}
        onDone={(res) => { setDone(res); setMode('done'); }}
        onCancel={() => setMode('idle')}
      />
    );
  }
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setSide('buy'); setMode('ticket'); }}
        title="Open the order ticket (all order types + stop-loss)"
        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-colors">
        <ShoppingCart className="h-3 w-3" /> Buy
      </button>
      {sellable && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setSide('sell'); setMode('ticket'); }}
          title="Open the order ticket to sell"
          className="inline-flex items-center px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors">
          Sell
        </button>
      )}
    </span>
  );
}
