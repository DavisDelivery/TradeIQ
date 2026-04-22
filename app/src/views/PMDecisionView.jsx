import { useState } from 'react';
import { SectionTitle, Skeleton } from './BoardView.jsx';

export default function PMDecisionView() {
  const [state, setState] = useState({ loading: false, error: null, decision: null });

  async function runPM() {
    setState({ loading: true, error: null, decision: null });
    try {
      // Pull the current board, then hand it to Claude-as-PM
      const boardRes = await fetch('/api/target-board');
      if (!boardRes.ok) throw new Error(`board: HTTP ${boardRes.status}`);
      const board = await boardRes.json();

      const pmRes = await fetch('/api/claude-pm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board }),
      });
      if (!pmRes.ok) throw new Error(`pm: HTTP ${pmRes.status}`);
      const decision = await pmRes.json();
      setState({ loading: false, error: null, decision });
    } catch (err) {
      setState({ loading: false, error: String(err), decision: null });
    }
  }

  return (
    <div>
      <SectionTitle>Claude as PM</SectionTitle>
      <p style={{ color: '#7a8ba7', marginBottom: 16, fontSize: 14, lineHeight: 1.5 }}>
        The mechanical ranker ranks. Claude decides which trades to actually take — applying
        judgment on correlation, regime, conviction, and invalidation.
      </p>

      <button onClick={runPM} disabled={state.loading} style={styles.runBtn}>
        {state.loading ? 'Claude is thinking...' : 'Generate portfolio'}
      </button>

      {state.error && (
        <div style={styles.error}>
          <strong>Error:</strong> {state.error}
        </div>
      )}

      {state.decision && <Decision d={state.decision} />}
    </div>
  );
}

function Decision({ d }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={styles.header}>
        <span>{d.date} · {d.regime.toUpperCase()}</span>
        <span>Gross {d.grossExposurePct}% · Net {d.netExposurePct}%</span>
      </div>

      <h3 style={styles.h3}>Selected ({d.selections.length})</h3>
      {d.selections.map((s, i) => (
        <Selection key={i} s={s} />
      ))}

      {d.portfolioNotes && (
        <div style={styles.notes}>
          <strong>Portfolio notes:</strong>
          <p>{d.portfolioNotes}</p>
        </div>
      )}

      {d.passes && d.passes.length > 0 && (
        <>
          <h3 style={styles.h3}>Passed ({d.passes.length})</h3>
          {d.passes.map((p, i) => (
            <div key={i} style={styles.pass}>
              <strong>{p.ticker}</strong> — {p.reason}
            </div>
          ))}
        </>
      )}

      <div style={styles.meta}>
        Model: {d.modelUsed} · Tokens: {d.tokensUsed}
      </div>
    </div>
  );
}

function Selection({ s }) {
  const sideColor = s.side === 'long' ? '#4ade80' : '#f87171';
  const conviction = {
    high: { bg: '#1e5b3b', label: 'HIGH' },
    medium: { bg: '#3b4e1e', label: 'MED' },
    low: { bg: '#4e3b1e', label: 'LOW' },
  }[s.conviction];

  return (
    <div style={{ borderLeft: `3px solid ${sideColor}`, padding: 16, marginBottom: 12, background: '#0a0e17' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span style={{ fontFamily: 'IBM Plex Serif, serif', fontSize: 22, fontWeight: 600 }}>
            {s.ticker}
          </span>
          <span style={{ color: sideColor, fontSize: 13, fontWeight: 500 }}>
            {s.side.toUpperCase()}
          </span>
          <span style={{ background: conviction.bg, color: '#e6edf3', padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 600 }}>
            {conviction.label}
          </span>
        </div>
        <span style={{ fontSize: 20, color: '#e6edf3', fontWeight: 600 }}>
          {s.positionSizePct}%
        </span>
      </div>
      <p style={{ color: '#cbd5e1', marginTop: 10, fontSize: 14, lineHeight: 1.5 }}>{s.thesis}</p>
      <div style={{ marginTop: 10, fontSize: 12, color: '#7a8ba7' }}>
        <div><strong style={{ color: '#a78bfa' }}>Risks:</strong> {s.risks}</div>
        <div style={{ marginTop: 4 }}><strong style={{ color: '#f87171' }}>Invalidation:</strong> {s.invalidation}</div>
      </div>
    </div>
  );
}

const styles = {
  runBtn: {
    background: '#4ade80',
    color: '#050607',
    border: 'none',
    padding: '12px 24px',
    fontSize: 15,
    fontWeight: 600,
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  error: {
    marginTop: 16,
    padding: 12,
    background: '#2a1010',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 13,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 12,
    color: '#7a8ba7',
    fontFamily: 'IBM Plex Mono, monospace',
    marginBottom: 16,
  },
  h3: {
    fontFamily: 'IBM Plex Serif, serif',
    fontSize: 16,
    fontWeight: 500,
    color: '#7a8ba7',
    margin: '24px 0 12px',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  notes: {
    marginTop: 16,
    padding: 14,
    background: '#0a0e17',
    border: '1px solid #1e2a3f',
    borderRadius: 4,
    fontSize: 13,
    lineHeight: 1.5,
    color: '#cbd5e1',
  },
  pass: {
    padding: '8px 12px',
    fontSize: 13,
    color: '#7a8ba7',
    borderLeft: '2px solid #1e2a3f',
    marginBottom: 6,
  },
  meta: {
    marginTop: 20,
    fontSize: 11,
    color: '#475569',
    fontFamily: 'IBM Plex Mono, monospace',
  },
};
