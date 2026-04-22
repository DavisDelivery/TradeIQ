import { useState } from 'react';
import { SectionTitle } from './BoardView.jsx';

export default function RegimeView() {
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [inputs, setInputs] = useState({ vix: 13.8, yield10y: 4.12, spread2s10s: 22 });

  async function runRegime() {
    setState({ loading: true, error: null, data: null });
    try {
      const res = await fetch('/api/regime-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({ loading: false, error: String(err), data: null });
    }
  }

  return (
    <div>
      <SectionTitle>Regime Narrative</SectionTitle>
      <p style={{ color: '#7a8ba7', fontSize: 14, marginBottom: 16, lineHeight: 1.5 }}>
        Claude reads the current macro state and recent headlines, then writes a trading-desk
        narrative. Overrides mechanical rules in borderline cases.
      </p>

      <div style={styles.inputs}>
        <Input label="VIX" value={inputs.vix} onChange={(v) => setInputs({ ...inputs, vix: +v })} />
        <Input label="10Y %" value={inputs.yield10y} onChange={(v) => setInputs({ ...inputs, yield10y: +v })} />
        <Input label="2s10s bp" value={inputs.spread2s10s} onChange={(v) => setInputs({ ...inputs, spread2s10s: +v })} />
      </div>

      <button onClick={runRegime} disabled={state.loading} style={styles.runBtn}>
        {state.loading ? 'Claude is writing...' : 'Generate narrative'}
      </button>

      {state.error && (
        <div style={styles.error}>
          <strong>Error:</strong> {state.error}
        </div>
      )}

      {state.data && <Narrative d={state.data} />}
    </div>
  );
}

function Input({ label, value, onChange }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#7a8ba7', marginBottom: 4 }}>{label}</div>
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 80,
          padding: '8px 10px',
          background: '#0a0e17',
          color: '#e6edf3',
          border: '1px solid #1e2a3f',
          borderRadius: 3,
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 14,
        }}
      />
    </div>
  );
}

function Narrative({ d }) {
  const regimeColor = { risk_on: '#4ade80', neutral: '#eab308', risk_off: '#f87171' }[d.regime];
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', marginBottom: 16 }}>
        <span style={{ color: regimeColor, fontSize: 22, fontWeight: 600, textTransform: 'uppercase' }}>
          {d.regime?.replace('_', ' ')}
        </span>
        <span style={{ color: '#7a8ba7', fontSize: 12 }}>confidence {(d.confidence * 100).toFixed(0)}%</span>
      </div>

      <p style={{ color: '#cbd5e1', fontSize: 15, lineHeight: 1.6, marginBottom: 20 }}>{d.narrative}</p>

      {d.disagreesWithMechanical && (
        <div style={{ padding: 12, background: '#2a1d10', border: '1px solid #7f5f1d', borderRadius: 4, marginBottom: 20, fontSize: 13, color: '#fcd34d' }}>
          <strong>⚠ Disagrees with mechanical rule.</strong> {d.disagreementReason}
        </div>
      )}

      {d.keyRisks && d.keyRisks.length > 0 && (
        <Section title="Key risks" items={d.keyRisks} color="#f87171" />
      )}

      {d.watchPoints && d.watchPoints.length > 0 && (
        <Section title="Watch points" items={d.watchPoints} color="#60a5fa" />
      )}

      {d.sectorBias && (
        <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div style={styles.sectorLabel}>Favor</div>
            {(d.sectorBias.favor ?? []).map((s, i) => (
              <div key={i} style={{ color: '#4ade80', fontSize: 13, marginBottom: 3 }}>+ {s}</div>
            ))}
          </div>
          <div>
            <div style={styles.sectorLabel}>Avoid</div>
            {(d.sectorBias.avoid ?? []).map((s, i) => (
              <div key={i} style={{ color: '#f87171', fontSize: 13, marginBottom: 3 }}>− {s}</div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, fontSize: 11, color: '#475569', fontFamily: 'IBM Plex Mono, monospace' }}>
        Model: {d.modelUsed} · Tokens: {d.tokensUsed}
      </div>
    </div>
  );
}

function Section({ title, items, color }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: '#7a8ba7', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
        {title}
      </div>
      {items.map((item, i) => (
        <div key={i} style={{ color: '#cbd5e1', fontSize: 13, marginBottom: 4, paddingLeft: 12, borderLeft: `2px solid ${color}` }}>
          {item}
        </div>
      ))}
    </div>
  );
}

const styles = {
  inputs: { display: 'flex', gap: 16, marginBottom: 16 },
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
  sectorLabel: {
    fontSize: 11,
    color: '#7a8ba7',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
};
