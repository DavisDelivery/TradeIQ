import { useEffect, useState } from 'react';

export default function BoardView() {
  const [state, setState] = useState({ loading: true, error: null, board: null });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/target-board')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((board) => !cancelled && setState({ loading: false, error: null, board }))
      .catch((err) =>
        !cancelled && setState({ loading: false, error: String(err), board: null }),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) return <Skeleton label="Loading board..." />;
  if (state.error)
    return (
      <div>
        <SectionTitle>Board unavailable</SectionTitle>
        <p style={{ color: '#7a8ba7' }}>{state.error}</p>
        <p style={{ color: '#7a8ba7', marginTop: 12 }}>
          The /api/target-board function isn't wired yet. That's the next session's scope.
        </p>
      </div>
    );

  const { regime, candidates } = state.board;
  return (
    <div>
      <RegimeStrip regime={regime} />
      <SectionTitle>{candidates.length} targets ranked</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {candidates.map((c) => (
          <CandidateCard key={c.ticker} c={c} />
        ))}
      </div>
    </div>
  );
}

function RegimeStrip({ regime }) {
  if (!regime) return null;
  return (
    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#7a8ba7', marginBottom: 16 }}>
      <span>REGIME {regime.regime?.toUpperCase()}</span>
      <span>VIX {regime.vix}</span>
      <span>10Y {regime.yield10y}%</span>
      <span>2s10s {regime.spread2s10s}bp</span>
    </div>
  );
}

function CandidateCard({ c }) {
  const tierColor = { A: '#4ade80', B: '#60a5fa', C: '#a78bfa' }[c.tier] ?? '#7a8ba7';
  return (
    <div style={{ borderLeft: `3px solid ${tierColor}`, padding: '12px 16px', background: '#0a0e17' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontFamily: 'IBM Plex Serif, serif', fontSize: 22, fontWeight: 600 }}>
          {c.ticker}
        </div>
        <div style={{ fontSize: 28, color: tierColor, fontWeight: 600 }}>{c.composite}</div>
      </div>
      <div style={{ fontSize: 12, color: '#7a8ba7', marginTop: 4 }}>
        ${c.price} · {c.changePct > 0 ? '+' : ''}{c.changePct}% · {c.side} · {c.tier}-tier
      </div>
      <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 8 }}>{c.blurb}</div>
    </div>
  );
}

export function SectionTitle({ children }) {
  return (
    <h2 style={{ fontFamily: 'IBM Plex Serif, serif', fontSize: 24, marginBottom: 16 }}>
      {children}
    </h2>
  );
}

export function Skeleton({ label }) {
  return <div style={{ color: '#7a8ba7', padding: 40, textAlign: 'center' }}>{label}</div>;
}
