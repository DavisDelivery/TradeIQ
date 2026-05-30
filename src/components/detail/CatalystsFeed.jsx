// Phase 6 PR-E — CatalystsFeed for the StockDetailPanel.
//
// Surfaces /api/stock-detail.catalysts:
//   - lastEarnings:   surprise%, price reaction
//   - nextEarnings:   countdown days, street EPS estimate
//   - insider:        net 90d $ flow, most recent role + amount
//   - news:           up to 5 items, last 30d
//   - upcomingEvents: e.g. next earnings
//
// All data already flows through useStockDetail (one fetch shared with
// metrics + relative strength + fundamental charts).

import React from 'react';
import { ExternalLink } from 'lucide-react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

function fmtUSD(v) {
  if (v == null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function fmtPct(v, dp = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
}

function pctColor(v) {
  if (v == null || !Number.isFinite(v)) return 'text-neutral-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-rose-400';
  return 'text-neutral-300';
}

export function CatalystsFeed({ ticker }) {
  const { data, isLoading, isError, error, refetch } = useStockDetail(ticker);
  const c = data?.catalysts ?? null;

  return (
    <section
      data-testid="catalysts-feed"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Catalysts
        </div>
      </header>

      {isLoading && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">loading catalysts…</div>
      )}
      {!isLoading && isError && (
        <div className="space-y-2">
          <div className="text-[11px] font-mono uppercase tracking-widest text-rose-300">couldn't load catalysts</div>
          <button onClick={() => refetch()} className="px-3 h-7 border border-neutral-700 text-[10px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 hover:border-neutral-500">↻ retry</button>
        </div>
      )}

      {!isLoading && !isError && !c && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">no catalyst data</div>
      )}

      {!isLoading && !isError && c && (
        <div className="space-y-4">
          <CatalystSubsection title="Earnings">
            {c.lastEarnings || c.nextEarnings ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {c.lastEarnings && (
                  <div className="bg-neutral-900/40 px-3 py-2 border border-neutral-800/60">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">
                      Last · {c.lastEarnings.date}
                    </div>
                    <div className="mt-1 text-[12px] font-mono text-neutral-100">
                      EPS {c.lastEarnings.epsActual ?? 'n/a'} vs {c.lastEarnings.epsEstimate ?? 'n/a'} est
                    </div>
                    {c.lastEarnings.surprisePct != null && (
                      <div className={`text-[11px] font-mono ${pctColor(c.lastEarnings.surprisePct)}`}>
                        surprise {fmtPct(c.lastEarnings.surprisePct)}
                      </div>
                    )}
                    {c.lastEarnings.priceReactionPct != null && (
                      <div className={`text-[10px] font-mono ${pctColor(c.lastEarnings.priceReactionPct)}`}>
                        price reaction {fmtPct(c.lastEarnings.priceReactionPct)}
                      </div>
                    )}
                  </div>
                )}
                {c.nextEarnings && (
                  <div className="bg-neutral-900/40 px-3 py-2 border border-neutral-800/60">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">
                      Next · {c.nextEarnings.date}
                    </div>
                    <div className="mt-1 text-[12px] font-mono text-neutral-100">
                      in {c.nextEarnings.daysUntil}d
                    </div>
                    {c.nextEarnings.epsEstimate != null && (
                      <div className="text-[11px] font-mono text-neutral-300">
                        Street EPS est ${c.nextEarnings.epsEstimate.toFixed(2)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <NoSubData label="no earnings data" />
            )}
          </CatalystSubsection>

          <CatalystSubsection title="Insider activity (90d)">
            {c.insider ? (
              <div className="bg-neutral-900/40 px-3 py-2 border border-neutral-800/60">
                <div className={`text-[14px] font-mono ${c.insider.net90dDollarVolume > 0 ? 'text-emerald-400' : c.insider.net90dDollarVolume < 0 ? 'text-rose-400' : 'text-neutral-300'}`}>
                  {fmtUSD(c.insider.net90dDollarVolume) ?? 'no flow'} net
                </div>
                {c.insider.last && (
                  <div className="mt-1 text-[10px] font-mono text-neutral-500">
                    latest: {c.insider.last.role} · {c.insider.last.action} {fmtUSD(c.insider.last.dollarValue)} · {c.insider.last.date}
                  </div>
                )}
              </div>
            ) : (
              <NoSubData label="no insider data" />
            )}
          </CatalystSubsection>

          <CatalystSubsection title="News (last 30d)">
            {c.news && c.news.length > 0 ? (
              <ul className="space-y-1.5" data-testid="news-list">
                {c.news.map((n, i) => (
                  <li key={`${n.url}-${i}`} className="text-[11px] font-mono">
                    <a
                      href={n.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-neutral-200 hover:text-emerald-300 inline-flex items-baseline gap-1"
                    >
                      <span className="text-neutral-500">{n.date}</span>
                      <span>· {n.headline}</span>
                      <ExternalLink className="h-3 w-3 inline align-baseline" />
                    </a>
                    {n.source && (
                      <span className="text-neutral-600"> · {n.source}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <NoSubData label="no news in window" />
            )}
          </CatalystSubsection>

          {c.upcomingEvents && c.upcomingEvents.length > 0 && (
            <CatalystSubsection title="Upcoming">
              <ul className="space-y-1">
                {c.upcomingEvents.map((e, i) => (
                  <li key={i} className="text-[11px] font-mono text-neutral-300">
                    <span className="text-neutral-500">{e.date}</span> · {e.description}
                  </li>
                ))}
              </ul>
            </CatalystSubsection>
          )}
        </div>
      )}
    </section>
  );
}

function CatalystSubsection({ title, children }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest font-mono text-neutral-600 mb-2">{title}</div>
      {children}
    </div>
  );
}

function NoSubData({ label }) {
  return (
    <div className="text-[10px] font-mono uppercase tracking-widest text-neutral-600">{label}</div>
  );
}
