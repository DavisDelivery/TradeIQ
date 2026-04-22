import { useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { SectionTitle } from './BoardView.jsx';

const DEFAULT_CONFIG = {
  tiersAllowed: ['A'],
  sidesAllowed: ['long'],
  sizing: 'vol-target',
  volTargetPct: 10,
  holdingDays: 10,
  maxPositions: 7,
  transactionCostBps: 5,
  slippageBps: 2,
  regimeGating: true,
};

export default function BacktestView() {
  const [state, setState] = useState({ loading: false, error: null, result: null });
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  async function runBacktest() {
    setState({ loading: true, error: null, result: null });
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      setState({ loading: false, error: null, result });
    } catch (err) {
      setState({ loading: false, error: String(err), result: null });
    }
  }

  return (
    <div>
      <SectionTitle>Backtest</SectionTitle>

      <ConfigPanel config={config} setConfig={setConfig} />

      <button onClick={runBacktest} disabled={state.loading} style={styles.runBtn}>
        {state.loading ? 'Running...' : 'Run backtest'}
      </button>

      {state.error && (
        <div style={styles.error}>
          <strong>Error:</strong> {state.error}
          <div style={{ marginTop: 8, fontSize: 12 }}>
            The backtest engine needs historical data hooks wired. That's next session's scope.
          </div>
        </div>
      )}

      {state.result && <Results r={state.result} />}
    </div>
  );
}

function ConfigPanel({ config, setConfig }) {
  return (
    <div style={styles.config}>
      <Row>
        <Label>Tiers</Label>
        <ButtonGroup
          value={config.tiersAllowed.join(',')}
          options={[
            { v: 'A', l: 'A only' },
            { v: 'A,B', l: 'A+B' },
            { v: 'A,B,C', l: 'All' },
          ]}
          onChange={(v) => setConfig({ ...config, tiersAllowed: v.split(',') })}
        />
      </Row>
      <Row>
        <Label>Sides</Label>
        <ButtonGroup
          value={config.sidesAllowed.join(',')}
          options={[
            { v: 'long', l: 'Longs only' },
            { v: 'long,short', l: 'Both' },
          ]}
          onChange={(v) => setConfig({ ...config, sidesAllowed: v.split(',') })}
        />
      </Row>
      <Row>
        <Label>Sizing</Label>
        <ButtonGroup
          value={config.sizing}
          options={[
            { v: 'equal', l: 'Equal' },
            { v: 'vol-target', l: 'Vol-target' },
            { v: 'kelly', l: 'Kelly' },
          ]}
          onChange={(v) => setConfig({ ...config, sizing: v })}
        />
      </Row>
      <Row>
        <Label>Regime gating</Label>
        <ButtonGroup
          value={config.regimeGating ? 'on' : 'off'}
          options={[
            { v: 'on', l: 'On' },
            { v: 'off', l: 'Off' },
          ]}
          onChange={(v) => setConfig({ ...config, regimeGating: v === 'on' })}
        />
      </Row>
    </div>
  );
}

function Row({ children }) {
  return <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>{children}</div>;
}
function Label({ children }) {
  return <div style={{ width: 110, fontSize: 12, color: '#7a8ba7' }}>{children}</div>;
}
function ButtonGroup({ value, options, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            background: value === o.v ? '#4ade80' : 'transparent',
            color: value === o.v ? '#050607' : '#cbd5e1',
            border: `1px solid ${value === o.v ? '#4ade80' : '#1e2a3f'}`,
            borderRadius: 3,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Results({ r }) {
  return (
    <div style={{ marginTop: 24 }}>
      <Stats r={r} />
      <Chart title="Equity curve vs SPY">
        <LineChart data={r.equityCurve}>
          <CartesianGrid stroke="#1e2a3f" />
          <XAxis dataKey="date" stroke="#7a8ba7" tick={{ fontSize: 11 }} />
          <YAxis stroke="#7a8ba7" tick={{ fontSize: 11 }} />
          <Tooltip contentStyle={{ background: '#0a0e17', border: '1px solid #1e2a3f' }} />
          <Legend />
          <Line type="monotone" dataKey="portfolio" stroke="#4ade80" dot={false} />
          <Line type="monotone" dataKey="spy" stroke="#7a8ba7" dot={false} />
        </LineChart>
      </Chart>

      <Chart title="Alpha by tier">
        <BarChart data={Object.entries(r.alphaByTier).map(([k, v]) => ({ tier: k, alpha: v }))}>
          <CartesianGrid stroke="#1e2a3f" />
          <XAxis dataKey="tier" stroke="#7a8ba7" />
          <YAxis stroke="#7a8ba7" tick={{ fontSize: 11 }} />
          <Tooltip contentStyle={{ background: '#0a0e17', border: '1px solid #1e2a3f' }} />
          <Bar dataKey="alpha" fill="#4ade80" />
        </BarChart>
      </Chart>

      <Chart title="Alpha by side">
        <BarChart data={Object.entries(r.alphaBySide).map(([k, v]) => ({ side: k, alpha: v }))}>
          <CartesianGrid stroke="#1e2a3f" />
          <XAxis dataKey="side" stroke="#7a8ba7" />
          <YAxis stroke="#7a8ba7" tick={{ fontSize: 11 }} />
          <Tooltip contentStyle={{ background: '#0a0e17', border: '1px solid #1e2a3f' }} />
          <Bar dataKey="alpha" fill="#60a5fa" />
        </BarChart>
      </Chart>

      <Chart title="Alpha by composite score bucket">
        <BarChart data={r.alphaByScoreBucket}>
          <CartesianGrid stroke="#1e2a3f" />
          <XAxis dataKey="bucket" stroke="#7a8ba7" />
          <YAxis stroke="#7a8ba7" tick={{ fontSize: 11 }} />
          <Tooltip contentStyle={{ background: '#0a0e17', border: '1px solid #1e2a3f' }} />
          <Bar dataKey="alpha" fill="#a78bfa" />
        </BarChart>
      </Chart>

      <TradesTable trades={r.trades} />
    </div>
  );
}

function Stats({ r }) {
  return (
    <div style={styles.stats}>
      <Stat label="Total alpha" value={`${r.totalAlpha.toFixed(2)}%`} color={r.totalAlpha > 0 ? '#4ade80' : '#f87171'} />
      <Stat label="Sharpe" value={r.sharpe.toFixed(2)} />
      <Stat label="Max DD" value={`${r.maxDrawdown.toFixed(1)}%`} color="#f87171" />
      <Stat label="Win rate" value={`${(r.winRate * 100).toFixed(0)}%`} />
      <Stat label="Trades" value={r.trades.length} />
    </div>
  );
}
function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#7a8ba7', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color ?? '#e6edf3', marginTop: 2 }}>{value}</div>
    </div>
  );
}
function Chart({ title, children }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={styles.h3}>{title}</h3>
      <ResponsiveContainer width="100%" height={220}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

function TradesTable({ trades }) {
  if (!trades || trades.length === 0) return null;
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={styles.h3}>Trades ({trades.length})</h3>
      <div style={{ overflowX: 'auto', fontSize: 12, fontFamily: 'IBM Plex Mono, monospace' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #1e2a3f', color: '#7a8ba7' }}>
              <th style={th}>Ticker</th>
              <th style={th}>Side</th>
              <th style={th}>Tier</th>
              <th style={th}>Entry</th>
              <th style={thR}>PnL%</th>
              <th style={thR}>Alpha%</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, 50).map((t, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #0e1420' }}>
                <td style={td}>{t.ticker}</td>
                <td style={{ ...td, color: t.side === 'long' ? '#4ade80' : '#f87171' }}>{t.side}</td>
                <td style={td}>{t.tier}</td>
                <td style={td}>{t.entry}</td>
                <td style={{ ...tdR, color: t.pnlPct > 0 ? '#4ade80' : '#f87171' }}>{t.pnlPct.toFixed(2)}</td>
                <td style={{ ...tdR, color: t.alpha > 0 ? '#4ade80' : '#f87171' }}>{t.alpha.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th = { textAlign: 'left', padding: '8px 12px 8px 0', fontWeight: 500 };
const thR = { textAlign: 'right', padding: '8px 0 8px 12px', fontWeight: 500 };
const td = { padding: '6px 12px 6px 0' };
const tdR = { padding: '6px 0 6px 12px', textAlign: 'right' };

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
    marginTop: 16,
  },
  config: {
    padding: 16,
    background: '#0a0e17',
    border: '1px solid #1e2a3f',
    borderRadius: 4,
    marginBottom: 8,
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
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
    gap: 16,
    padding: 16,
    background: '#0a0e17',
    border: '1px solid #1e2a3f',
    borderRadius: 4,
  },
  h3: {
    fontFamily: 'IBM Plex Serif, serif',
    fontSize: 14,
    fontWeight: 500,
    color: '#7a8ba7',
    margin: '0 0 12px',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
};
