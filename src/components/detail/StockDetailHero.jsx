// Phase 6 W2 — StockDetailPanel hero.
//
// The "what + how does the strategy rate it" header: ticker, company name,
// sector, price + day change, market cap, the board-specific score badge,
// and a one-tap Log-as-trade button. Data-driven from the strategy rationale
// endpoint (name/sector/score/direction) enriched by the stock-detail bundle
// (price/day-change/market-cap) when it arrives; falls back to the board row
// so the hero paints instantly on open and never blanks.

import React from 'react';
import { LogButton } from '../LogButton.jsx';
import { QueueOrderButton } from '../QueueOrderButton.jsx';
import { fmt } from '../../lib/formatters.jsx';
import { ScoreBadge } from './ScoreBadge.jsx';

function formatMarketCap(n) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

export function StockDetailHero({ board, ticker, rationale, detail, row, thesis }) {
  const name =
    detail?.name ?? rationale?.name ?? row?.companyName ?? row?.name ?? null;
  const sector = detail?.sector ?? rationale?.sector ?? row?.sector ?? null;
  const price = detail?.price ?? rationale?.price ?? row?.price ?? null;
  const dayChangePct =
    detail?.dayChangePct ?? row?.priceChangePct ?? null;
  const marketCap = formatMarketCap(detail?.marketCap);

  const composite =
    board === 'target'
      ? rationale?.composite ?? row?.composite ?? null
      : Math.round(rationale?.score ?? row?.score ?? 0);
  const direction = rationale?.direction ?? row?.direction ?? null;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-serif font-bold text-2xl xl:text-3xl tracking-tight text-neutral-100">
            {ticker}
          </h2>
          {(name && name !== ticker) && (
            <div className="text-[13px] text-neutral-200 mt-0.5 truncate" title={name}>
              {name}
            </div>
          )}
          {sector && (
            <div className="text-[10px] uppercase tracking-widest font-mono text-neutral-500 mt-0.5">
              {sector}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 text-right">
          <ScoreBadge board={board} rationale={rationale} row={row} />
          <div className="text-[9px] text-neutral-500 font-mono uppercase tracking-widest mt-1">
            {board === 'target' ? 'composite' : `${board} score`}
          </div>
        </div>
      </div>

      <div className="mt-2 font-mono text-[12px] text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-neutral-200">{fmt.moneyDec(price)}</span>
        {dayChangePct != null && (
          <span className={dayChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {fmt.pct(dayChangePct)}
          </span>
        )}
        {marketCap && (
          <>
            <span className="text-neutral-700">│</span>
            <span>
              <span className="text-neutral-500 uppercase tracking-widest mr-1">Mkt cap</span>
              <span className="text-neutral-200">{marketCap}</span>
            </span>
          </>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <LogButton
          size="sm"
          payload={{
            ticker,
            source: board,
            loggedPrice: price,
            composite,
            tier: board === 'target' ? (rationale?.tier ?? row?.tier) : undefined,
            direction,
            rationale: thesis ?? row?.rationale ?? '',
          }}
        />
        {/* Agentic-trading bridge (runbook Phase 2): queue a real buy for
            the execution agent. Queuing IS the approval. */}
        <QueueOrderButton ticker={ticker} sourceBoard={board} price={price} rationale={thesis ?? row?.rationale ?? ''} />
      </div>
    </div>
  );
}
