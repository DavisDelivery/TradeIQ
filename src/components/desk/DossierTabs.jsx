// DESK-1 W3 — evidence dossier under the focus chart. Five tabs, each a
// single React-Query-cached fetch per ticker (session-memoized hooks):
//
//   RATIONALE    — the 4q per-analyst accordion (useTargetRationale)
//   FUNDAMENTALS — company block + fundamentals strip + P/E + margins trend
//   INSIDER      — 90d net buys/sells + last-10 filings table (sortable).
//                  Insider lives HERE, dossier-level, NOT as a watchlist
//                  column — a per-row insider fetch would burn the
//                  Finnhub budget for zero glanceable value.
//   EARNINGS     — earnings-radar detail + last-4 surprise history
//   AI BRIEF     — the existing on-demand research endpoint. NEVER
//                  auto-fires (ResearchPanel is button-gated) and renders
//                  with the board verdict chip + model/date stamp.
//
// This tab presents EVIDENCE, not predictions: every model-derived
// number carries its verdict chip via the embedded components.

import React, { useMemo, useState } from 'react';
import { useTargetRationale } from '../../hooks/useTargetRationale.js';
import { useStockDetail } from '../../hooks/useStockDetail.js';
import { useInsiderDetail } from '../../hooks/useInsiderDetail.js';
import { useEarningsRadar } from '../../hooks/useEarningsRadar.js';
import { AnalystContributions } from '../AnalystContributions.jsx';
import { CompanyInfo } from '../CompanyInfo.jsx';
import { FundamentalsStrip } from '../detail/FundamentalsStrip.jsx';
import { ResearchPanel } from '../ResearchPanel.jsx';
import { VerdictChip } from '../VerdictChip.jsx';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';
import { readLog } from '../../tradeLog.js';
import { tickerRecord } from '../../lib/baseRates.js';
import { OrderButtons } from '../OrderButtons.jsx';

const TABS = ['RATIONALE', 'FUNDAMENTALS', 'INSIDER', 'EARNINGS', 'AI BRIEF'];

const dash = <span className="text-neutral-700">—</span>;

function fmtDollars(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const s = abs >= 1e9 ? `$${(abs / 1e9).toFixed(2)}B`
    : abs >= 1e6 ? `$${(abs / 1e6).toFixed(2)}M`
      : abs >= 1e3 ? `$${(abs / 1e3).toFixed(0)}K`
        : `$${abs.toFixed(0)}`;
  return n < 0 ? `−${s}` : s;
}

// ---------------------------------------------------------------------------

export function DossierTabs({ ticker }) {
  const [tab, setTab] = useState('RATIONALE');

  // Your record on this ticker (W4 one-liner) — closed journal trades.
  const record = useMemo(() => tickerRecord(readLog(), ticker), [ticker]);

  return (
    <div data-testid="desk-dossier" className="border border-neutral-800 bg-neutral-950/40 mt-3">
      {/* Trade this ticker straight from the dossier — places a real
          Robinhood order (broker-execute). The server fetches the live quote
          for pricing + the $500/order cap. */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-neutral-800/80">
        <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">{ticker}</span>
        <OrderButtons ticker={ticker} sourceBoard="desk" />
      </div>
      <div className="flex items-center border-b border-neutral-800/80 overflow-x-auto scrollbar-hide">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 h-9 text-[10px] font-mono uppercase tracking-widest whitespace-nowrap transition-colors border-b-2 ${
              tab === t
                ? 'text-emerald-400 border-emerald-400 bg-emerald-500/5'
                : 'text-neutral-500 border-transparent hover:text-neutral-300'
            }`}
          >
            {t}
          </button>
        ))}
        {record && (
          <div
            className="ml-auto px-3 text-[10px] font-mono text-neutral-500 whitespace-nowrap"
            data-testid="dossier-record"
            title="Your closed journal trades on this ticker"
          >
            your record: {record.n} closed · {(record.winRate * 100).toFixed(0)}% win ·{' '}
            <span className={record.netPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {record.netPct >= 0 ? '+' : ''}{record.netPct}pp
            </span>
          </div>
        )}
      </div>

      <div className="p-3">
        {tab === 'RATIONALE' && <RationaleTab ticker={ticker} />}
        {tab === 'FUNDAMENTALS' && <FundamentalsTab ticker={ticker} />}
        {tab === 'INSIDER' && <InsiderTab ticker={ticker} />}
        {tab === 'EARNINGS' && <EarningsTab ticker={ticker} />}
        {tab === 'AI BRIEF' && <ResearchPanel ticker={ticker} board="target" />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RATIONALE — reuse the 4q accordion. The Desk may focus a ticker that
// isn't on any board snapshot, so we synthesize the thin `target` shape
// the accordion expects from the live-recompute response itself.
// ---------------------------------------------------------------------------

function RationaleTab({ ticker }) {
  const { data, isLoading, error } = useTargetRationale(ticker, { enabled: !!ticker });

  const target = useMemo(() => {
    if (!data?.analysts?.length) return null;
    return {
      ticker,
      composite: data.composite,
      tier: data.tier,
      analystContributions: data.analysts.map((a) => ({
        analyst: a.analyst,
        score: a.score,
        direction: a.direction,
        weight: a.weight,
      })),
      scoredAnalysts: data.analysts.map((a) => a.analyst),
      noDataAnalysts: [],
    };
  }, [data, ticker]);

  if (isLoading) return <Pending label={`Recomputing analyst scores for ${ticker}…`} />;
  if (error) return <Failed label={`Rationale unavailable: ${error.message}`} />;
  if (!target) return <Failed label="No analyst rationale returned for this ticker." />;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-[11px] font-mono text-neutral-400">
        <span>Composite <span className="text-neutral-200 tabular-nums">{data.composite ?? '—'}</span></span>
        {data.tier && <span>Tier <span className="text-neutral-200">{data.tier}</span></span>}
        <VerdictChip board="target" compact />
      </div>
      <AnalystContributions target={target} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// FUNDAMENTALS — company block + strip + P/E + margins trend, all from
// the session-cached ticker-info / stock-detail fetches.
// ---------------------------------------------------------------------------

function FundamentalsTab({ ticker }) {
  const { data, isLoading } = useStockDetail(ticker, { enabled: !!ticker });

  const quarterly = data?.fundamentalsHistory?.quarterly ?? [];
  // Newest first or last? Sort by endDate ascending, take latest + 4-back.
  const sorted = useMemo(
    () => [...quarterly].sort((a, b) => String(a.endDate).localeCompare(String(b.endDate))),
    [quarterly],
  );
  const latest = sorted[sorted.length - 1] ?? null;
  const yearAgo = sorted.length >= 5 ? sorted[sorted.length - 5] : null;
  const pe = data?.metrics?.valuation?.pe ?? null;

  return (
    <div className="space-y-3">
      <CompanyInfo ticker={ticker} />
      <FundamentalsStrip ticker={ticker} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
        <Metric label="P/E (now)" value={pe != null ? pe.toFixed(1) : null} />
        <Metric
          label="Gross margin"
          value={latest?.grossMargin != null ? `${latest.grossMargin.toFixed(1)}%` : null}
          delta={latest?.grossMargin != null && yearAgo?.grossMargin != null
            ? latest.grossMargin - yearAgo.grossMargin : null}
        />
        <Metric
          label="Op margin"
          value={latest?.opMargin != null ? `${latest.opMargin.toFixed(1)}%` : null}
          delta={latest?.opMargin != null && yearAgo?.opMargin != null
            ? latest.opMargin - yearAgo.opMargin : null}
        />
        <Metric
          label="Net margin"
          value={latest?.netMargin != null ? `${latest.netMargin.toFixed(1)}%` : null}
        />
      </div>
      {isLoading && <Pending label="Loading fundamentals…" />}
      {!isLoading && quarterly.length === 0 && (
        <div className="text-[10px] font-mono text-neutral-600">
          Quarterly history unavailable for this ticker.
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, delta }) {
  return (
    <div className="border border-neutral-800 bg-neutral-900/40 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-widest text-neutral-600 mb-0.5">{label}</div>
      <div className="text-neutral-200 tabular-nums">
        {value ?? dash}
        {typeof delta === 'number' && Number.isFinite(delta) && (
          <span className={`ml-1.5 text-[10px] ${delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {delta >= 0 ? '+' : ''}{delta.toFixed(1)}pp y/y
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// INSIDER — net dollars + last-10 filings (sortable, standing rule).
// ---------------------------------------------------------------------------

function InsiderTab({ ticker }) {
  const { data, isLoading, error } = useInsiderDetail(ticker, { enabled: !!ticker });
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('filingDate', 'desc');

  if (isLoading) return <Pending label="Loading 90d insider filings…" />;
  if (error) return <Failed label={`Insider data unavailable: ${error.message}`} />;
  if (!data || data.dataUnavailable) {
    return <Failed label="Insider feed unavailable right now (Finnhub) — data is missing, not absent." />;
  }

  const filings = sortRows(data.filings ?? []);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-3 text-[11px] font-mono">
        <span className="text-neutral-500">Net 90d</span>
        <span className={`tabular-nums ${
          (data.netDollars ?? 0) > 0 ? 'text-emerald-400' : (data.netDollars ?? 0) < 0 ? 'text-rose-400' : 'text-neutral-300'
        }`}>
          {fmtDollars(data.netDollars)}
        </span>
        <span className="text-neutral-600">buys {fmtDollars(data.buyDollars)} · sells {fmtDollars(data.sellDollars)}</span>
        <span className="text-neutral-600">{data.totalBuys ?? 0}B / {data.totalSells ?? 0}S · {data.uniqueBuyers ?? 0} buyers</span>
      </div>

      {filings.length === 0 ? (
        <div className="text-[11px] font-mono text-neutral-600">No Form 4 filings in the last 90 days.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-neutral-500 border-b border-neutral-800/80">
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="filingDate">Filed</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="name">Insider</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="position">Role</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="transactionCode" align="center">Code</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="share" align="right">Shares</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="transactionPrice" align="right">Price</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="dollarValue" align="right">Value</SortableTh>
              </tr>
            </thead>
            <tbody>
              {filings.map((f, i) => (
                <tr key={`${f.filingDate}-${f.name}-${i}`} className="border-b border-neutral-900">
                  <td className="px-3 py-1.5 text-neutral-400">{f.filingDate}</td>
                  <td className="px-3 py-1.5 text-neutral-200">{f.name}</td>
                  <td className="px-3 py-1.5 text-neutral-400">{f.position || '—'}</td>
                  <td className={`px-3 py-1.5 text-center ${f.transactionCode === 'P' ? 'text-emerald-400' : f.transactionCode === 'S' ? 'text-rose-400' : 'text-neutral-400'}`}>
                    {f.transactionCode}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${f.share > 0 ? 'text-emerald-400' : f.share < 0 ? 'text-rose-400' : 'text-neutral-300'}`}>
                    {f.share > 0 ? '+' : ''}{f.share.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">
                    {Number.isFinite(f.transactionPrice) && f.transactionPrice > 0 ? f.transactionPrice.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-200">{fmtDollars(f.dollarValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EARNINGS — radar detail + last-4 surprise history.
// ---------------------------------------------------------------------------

function EarningsTab({ ticker }) {
  const { radarByTicker, isLoading, error } = useEarningsRadar(ticker ? [ticker] : []);
  const r = radarByTicker[ticker];

  if (isLoading) return <Pending label="Loading earnings radar…" />;
  if (error) return <Failed label={`Earnings radar unavailable: ${error.message}`} />;
  if (!r) return <Failed label="No earnings data returned for this ticker." />;

  const denom = r.beatsLast4Quarters ?? 0;

  return (
    <div className="space-y-3 text-[11px] font-mono">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric
          label="Next report"
          value={r.nextEarningsDate ?? null}
        />
        <Metric
          label="Days until"
          value={r.daysUntil != null && r.daysUntil >= 0 ? `${r.daysUntil}d` : null}
        />
        <Metric
          label="Beats"
          value={r.beatsLast4 != null && denom > 0 ? `${r.beatsLast4}/${denom}` : null}
        />
        <Metric
          label="Last surprise"
          value={r.lastSurprisePct != null
            ? `${r.lastSurprisePct > 0 ? '+' : ''}${r.lastSurprisePct.toFixed(1)}%`
            : null}
        />
      </div>
      {r.beatsLast4 == null && (
        <div className="text-[10px] text-neutral-600">
          No usable surprise history from the provider — shown as no-data, not 0 beats.
        </div>
      )}

      {(r.surpriseHistory?.length ?? 0) > 0 && (
        <table className="w-full">
          <thead>
            <tr className="text-neutral-500 border-b border-neutral-800/80 text-left">
              <th className="px-3 py-1.5 text-[10px] uppercase tracking-widest font-normal">Period</th>
              <th className="px-3 py-1.5 text-[10px] uppercase tracking-widest font-normal text-right">EPS act</th>
              <th className="px-3 py-1.5 text-[10px] uppercase tracking-widest font-normal text-right">EPS est</th>
              <th className="px-3 py-1.5 text-[10px] uppercase tracking-widest font-normal text-right">Surprise</th>
            </tr>
          </thead>
          <tbody>
            {r.surpriseHistory.map((h) => (
              <tr key={h.period} className="border-b border-neutral-900">
                <td className="px-3 py-1.5 text-neutral-400">{h.period}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-200">{h.epsActual?.toFixed?.(2) ?? '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-400">{h.epsEstimate?.toFixed?.(2) ?? '—'}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${
                  h.surprisePct == null ? 'text-neutral-600' : h.surprisePct > 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}>
                  {h.surprisePct != null ? `${h.surprisePct > 0 ? '+' : ''}${h.surprisePct.toFixed(1)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Pending({ label }) {
  return <div className="py-4 text-center text-[11px] font-mono text-neutral-500">{label}</div>;
}

function Failed({ label }) {
  return <div className="py-4 text-center text-[11px] font-mono text-neutral-600">{label}</div>;
}

// Exposed for tests.
export const _internals = { TABS };
