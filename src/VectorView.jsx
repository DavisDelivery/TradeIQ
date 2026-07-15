import React, { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Zap, Eye, Landmark, Info } from 'lucide-react';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';
import { VerdictChip } from './components/VerdictChip.jsx';
import { useRegime } from './hooks/useRegime.js';
import { fetchWithRetry } from './lib/validateResponse.js';
import { queryKeys } from './lib/queryKeys.js';

// VECTOR — event-driven library board (reports/vector/design.md).
// Live event feed (newest first) + a ticker evaluator that issues the
// two-axis F/T verdict on ANY hygiene-passing symbol. Every quadrant badge
// ships with its cohort's measured forward distribution — naked labels
// never ship; the chip stays PENDING until the pre-committed validation
// run resolves it.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const EVENT_META = {
  E1: { label: 'Earnings surprise', icon: Zap, color: 'text-amber-300 border-amber-500/40 bg-amber-500/5' },
  E2: { label: 'Insider cluster', icon: Eye, color: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/5' },
  E3: { label: 'Activist 13D', icon: Landmark, color: 'text-violet-300 border-violet-500/40 bg-violet-500/5' },
};

const QUADRANT_STYLE = {
  PRIME: 'text-emerald-300 border-emerald-500/50 bg-emerald-500/10',
  WAIT: 'text-sky-300 border-sky-500/40 bg-sky-500/5',
  RENT: 'text-amber-300 border-amber-500/40 bg-amber-500/5',
  PASS: 'text-neutral-500 border-neutral-700 bg-neutral-900/40',
};

const QuadrantBadge = ({ q }) => (
  <span className={`inline-flex px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest border ${QUADRANT_STYLE[q] ?? QUADRANT_STYLE.PASS}`}>
    {q ?? '—'}
  </span>
);

// F/T pillar bar: points relative to axis max.
const PillarBar = ({ label, points, max, verdict, noData }) => (
  <div className="flex items-center gap-2">
    <span className="w-4 text-[10px] font-mono text-neutral-500">{label}</span>
    <div className="flex-1 h-1.5 bg-neutral-900 overflow-hidden">
      <div
        className={`h-full ${verdict === 'STRONG' || verdict === 'GOOD' ? 'bg-emerald-400' : verdict === 'WEAK' || verdict === 'POOR' ? 'bg-rose-500' : 'bg-amber-400'}`}
        style={{ width: `${Math.max(0, Math.min(100, (points / max) * 100))}%` }}
      />
    </div>
    <span className="text-[11px] font-mono text-neutral-300 w-24 text-right">
      {verdict} {points}/{max}
      {noData?.length > 0 && <span className="text-neutral-600" title={`no data: ${noData.join(', ')}`}> ·{noData.length}∅</span>}
    </span>
  </div>
);

function useVectorFeed(type) {
  return useQuery({
    queryKey: [...queryKeys.all, 'vectorFeed', type],
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/vector-feed?limit=60${type !== 'all' ? `&type=${type}` : ''}`, { signal });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
    staleTime: 10 * 60 * 1000,
  });
}

function useVectorEvaluate(ticker) {
  return useQuery({
    queryKey: [...queryKeys.all, 'vectorEvaluate', ticker],
    enabled: !!ticker,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/vector-evaluate?ticker=${ticker}`, { signal });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
    staleTime: 10 * 60 * 1000,
  });
}

// Cohort line, lazily fetched per (type, sizeBucket) — the shared cache
// dedupes identical cohorts across cards.
function CohortLine({ type, sizeBucket }) {
  const { data } = useQuery({
    queryKey: [...queryKeys.all, 'vectorCohort', type, sizeBucket],
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/vector-cohort?type=${type}&dim1=sizeBucket:${sizeBucket}`, { signal });
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
  });
  if (!data?.available) {
    return <div className="text-[10px] font-mono text-neutral-600">library pending — validation run has not completed</div>;
  }
  if (data.insufficientHistory) {
    return <div className="text-[10px] font-mono text-neutral-600">insufficient history (n={data.n} &lt; 30)</div>;
  }
  return (
    <div className="text-[11px] font-mono text-neutral-400">
      {data.cohortLine}
      {data.wideCi && <span className="text-amber-400/80" title="n < 100 — wide confidence interval"> · wide CI</span>}
    </div>
  );
}

const EventCard = ({ e, onOpen }) => {
  const meta = EVENT_META[e.type] ?? EVENT_META.E1;
  const Icon = meta.icon;
  const p = e.payload ?? {};
  return (
    <button
      type="button"
      onClick={() => onOpen(e)}
      className="w-full text-left border border-neutral-800 hover:border-neutral-600 bg-neutral-950/40 p-3 transition-colors"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${meta.color}`}>
          <Icon className="h-3 w-3" /> {meta.label}
        </span>
        <span className="font-serif font-bold text-lg">{e.ticker}</span>
        <span className="text-[10px] font-mono text-neutral-500 uppercase">{e.sizeBucket}</span>
        <span className="ml-auto text-[11px] font-mono text-neutral-400">{fmtDate(e.date)}</span>
      </div>
      <div className="mt-1.5 text-[11px] font-mono text-neutral-400">
        {e.type === 'E1' && <>SUE {p.sue ?? '—'} · reaction {p.reaction != null ? `${(p.reaction * 100).toFixed(1)}%` : '—'} · vol {p.volumeShock != null ? `${p.volumeShock}x` : '—'}</>}
        {e.type === 'E2' && <>{p.buyers?.length ?? '—'} buyers · ${p.aggregateDollars ? (p.aggregateDollars / 1000).toFixed(0) : '—'}k · {p.distToHigh != null ? `${((1 - p.distToHigh) * 100).toFixed(0)}% off high` : '—'}{p.sellCluster ? ' · sell-cluster ⚠' : ''}{p.routineScreen === 'reduced' ? ' · reduced screen' : ''}</>}
        {e.type === 'E3' && <>{p.company ?? '—'} · {p.regime === 'post5day' ? '5-day regime' : '10-day regime'}</>}
      </div>
      <div className="mt-1.5">
        <CohortLine type={e.type} sizeBucket={e.sizeBucket} />
      </div>
    </button>
  );
};

const Legend = () => (
  <details className="border border-neutral-800 bg-neutral-950/40 p-3 text-[11px] text-neutral-400 leading-relaxed">
    <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-widest text-neutral-500 flex items-center gap-1.5">
      <Info className="h-3 w-3" /> How to read this board
    </summary>
    <div className="mt-2 space-y-2">
      <p><strong className="text-neutral-300">Events, not rankings.</strong> VECTOR sits flat until something happens on the record: a company reports a real earnings surprise the tape agrees with (E1), two or more insiders buy a beaten-down stock with their own money (E2), or an activist crosses 5% and files a 13D (E3). Each card is one such event.</p>
      <p><strong className="text-neutral-300">The cohort line is the evidence.</strong> "n=214 like this" means 214 similar historical events; the numbers are what actually happened next, net of costs. No cohort stats = the library hasn't measured that cell yet.</p>
      <p><strong className="text-neutral-300">Two-axis verdict.</strong> F = is it fundamentally a good buy (surprises, insider money, institutions). T = is now a good entry (trend, extension, regime; a falling knife must stabilize first). PRIME = both. WAIT = right company, wrong moment. RENT = trade it, don't own it. PASS = neither.</p>
      <p><strong className="text-neutral-300">∅ marks missing data.</strong> A pillar that can't be computed says so and scores nothing — it is never silently filled in.</p>
    </div>
  </details>
);

export const VectorView = () => {
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [evalTicker, setEvalTicker] = useState('');
  const [selected, setSelected] = useState(null);
  const feed = useVectorFeed(typeFilter);
  const evaluation = useVectorEvaluate(evalTicker);
  const { data: regime } = useRegime();

  const events = feed.data?.events ?? [];

  const submitSearch = (ev) => {
    ev.preventDefault();
    const t = searchInput.toUpperCase().trim();
    if (t) setEvalTicker(t);
  };

  const list = (
    <div className="px-3 py-4 sm:p-6 max-w-[1200px] mx-auto space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-1.5">
            Event library · earnings surprises · insider clusters · activist stakes
          </div>
          <h1 className="font-serif text-3xl font-bold tracking-tight flex items-center gap-3">
            VECTOR <VerdictChip board="vector" />
          </h1>
        </div>
        {regime?.regime && (
          <div className={`px-3 py-1.5 border text-[11px] font-mono uppercase tracking-wider ${
            regime.regime === 'risk_on' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/5'
            : regime.regime === 'risk_off' ? 'text-rose-300 border-rose-500/40 bg-rose-500/5'
            : 'text-neutral-400 border-neutral-700 bg-neutral-900/40'
          }`}>
            regime {regime.regime.replace('_', ' ')}
          </div>
        )}
      </div>

      {/* Evaluator search */}
      <form onSubmit={submitSearch} className="flex gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-600" />
          <input
            value={searchInput}
            onChange={(ev) => setSearchInput(ev.target.value)}
            placeholder="Evaluate any ticker…"
            className="w-full h-9 pl-8 pr-3 bg-neutral-950 border border-neutral-800 text-[13px] font-mono text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 outline-none"
          />
        </div>
        <button type="submit" className="px-3 h-9 border border-neutral-800 text-[11px] font-mono uppercase tracking-widest text-neutral-400 hover:text-neutral-200 hover:border-neutral-600">
          Evaluate
        </button>
      </form>

      {/* Evaluator result */}
      {evalTicker && (
        <div className="border border-neutral-700 bg-neutral-950/60 p-4" data-testid="vector-evaluator">
          {evaluation.isLoading && <div className="text-[12px] font-mono text-neutral-500">evaluating {evalTicker}…</div>}
          {evaluation.error && <div className="text-[12px] font-mono text-rose-300">{evaluation.error.message}</div>}
          {evaluation.data?.ok === false && <div className="text-[12px] font-mono text-neutral-400">{evaluation.data.error}</div>}
          {evaluation.data?.ok && evaluation.data.hygiene && !evaluation.data.f && (
            <div className="text-[12px] font-mono text-neutral-400">
              {evalTicker} fails universe hygiene (close ${evaluation.data.hygiene.close?.toFixed(2) ?? '—'},
              {' '}{evaluation.data.hygiene.bars} bars, ${((evaluation.data.hygiene.medianDollarVol63d ?? 0) / 1e6).toFixed(1)}M median $vol) — no verdict issued.
            </div>
          )}
          {evaluation.data?.f && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-serif font-bold text-2xl">{evaluation.data.ticker}</span>
                <QuadrantBadge q={evaluation.data.quadrant} />
                <span className="text-[10px] font-mono text-neutral-500 uppercase">{evaluation.data.hygiene.sizeBucket}</span>
                <button
                  type="button"
                  onClick={() => setSelected({ ticker: evaluation.data.ticker })}
                  className="ml-auto text-[10px] font-mono uppercase tracking-widest text-neutral-500 hover:text-neutral-200"
                >
                  full dossier →
                </button>
              </div>
              <PillarBar label="F" points={evaluation.data.f.points} max={evaluation.data.f.max} verdict={evaluation.data.f.verdict} noData={evaluation.data.f.noData} />
              <PillarBar label="T" points={evaluation.data.t.points} max={5} verdict={evaluation.data.t.verdict} noData={evaluation.data.t.noData} />
              {evaluation.data.t.drawdownVariant && (
                <div className="text-[10px] font-mono text-neutral-500">drawdown ≥20% — timing judged on stabilization (close &gt; EMA20 + higher 5-day low), not trend points</div>
              )}
              {evaluation.data.t.forcedPoor && (
                <div className="text-[10px] font-mono text-rose-400/80">timing forced POOR: {evaluation.data.t.forcedPoor}</div>
              )}
              <div className="text-[11px] font-mono text-neutral-500">
                F sub-scores: {evaluation.data.f.parts.map((p) => `${p.rule} ${p.points > 0 ? '+' : ''}${p.points}`).join(' · ') || '—'}
              </div>
              {evaluation.data.events?.length > 0 && (
                <div className="text-[11px] font-mono text-neutral-400">
                  recent events: {evaluation.data.events.slice(0, 4).map((e) => `${e.type} ${fmtDate(e.date)}`).join(' · ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Legend />

      {/* Feed filter chips */}
      <div className="flex border border-neutral-800 w-fit">
        {['all', 'E1', 'E2', 'E3'].map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            className={`px-3 h-8 text-[11px] font-mono uppercase tracking-widest transition-colors ${
              typeFilter === t ? 'text-emerald-300 bg-emerald-500/10' : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t === 'all' ? 'All' : EVENT_META[t].label.split(' ')[0]}
          </button>
        ))}
      </div>

      {/* Feed */}
      {feed.error && !events.length && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-3 text-rose-300 font-mono text-[11px]">
          feed failed: {feed.error.message}
        </div>
      )}
      {feed.isLoading && !events.length && (
        <div className="border border-neutral-800 overflow-hidden">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-20 border-b border-neutral-900/60 bg-neutral-900/30 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      )}
      {!feed.isLoading && events.length === 0 && !feed.error && (
        <div className="border border-neutral-800 p-10 text-center">
          <div className="text-neutral-500 font-mono text-sm mb-2">No events in the library yet.</div>
          <div className="text-neutral-600 text-[11px] font-mono">Backfills populate this feed. A scheduled live scanner is a named follow-up — until it ships, new events only land when a backfill runs.</div>
        </div>
      )}
      <div className="space-y-2">
        {events.map((e) => <EventCard key={e.id} e={e} onOpen={(ev) => setSelected(ev)} />)}
      </div>
    </div>
  );

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={selected ? <StockDetailPanel board="vector" ticker={selected.ticker} row={selected} /> : null}
      closeLabel="Close VECTOR detail"
    />
  );
};
