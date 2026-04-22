import { useState } from 'react';
import BoardView from './views/BoardView.jsx';
import BacktestView from './views/BacktestView.jsx';
import PMDecisionView from './views/PMDecisionView.jsx';
import RegimeView from './views/RegimeView.jsx';

const TABS = [
  { id: 'board', label: 'Board' },
  { id: 'pm', label: 'PM' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'regime', label: 'Regime' },
];

export default function App() {
  const [tab, setTab] = useState('board');

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div style={styles.brand}>
          <span style={styles.alpha}>α</span>
          <div>
            <div style={styles.title}>
              TradeIQ <em style={styles.alphaTxt}>Alpha</em>
            </div>
            <div style={styles.version}>MULTI-FACTOR · 0.2.0-ALPHA</div>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {tab === 'board' && <BoardView />}
        {tab === 'pm' && <PMDecisionView />}
        {tab === 'backtest' && <BacktestView />}
        {tab === 'regime' && <RegimeView />}
      </main>

      <nav style={styles.bottomNav}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...styles.navBtn,
              color: tab === t.id ? '#4ade80' : '#7a8ba7',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const styles = {
  shell: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    background: '#050607',
    color: '#e6edf3',
  },
  header: {
    padding: '16px 20px',
    borderBottom: '1px solid #1e2a3f',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  alpha: {
    width: 44,
    height: 44,
    display: 'grid',
    placeItems: 'center',
    background: '#0a1f14',
    border: '1px solid #1e5b3b',
    color: '#4ade80',
    fontFamily: 'IBM Plex Serif, serif',
    fontSize: 22,
    fontStyle: 'italic',
    borderRadius: 4,
  },
  title: {
    fontFamily: 'IBM Plex Serif, serif',
    fontSize: 20,
    fontWeight: 600,
  },
  alphaTxt: {
    color: '#4ade80',
    fontStyle: 'italic',
    fontWeight: 400,
  },
  version: {
    fontFamily: 'IBM Plex Mono, monospace',
    fontSize: 11,
    color: '#7a8ba7',
    marginTop: 2,
  },
  main: {
    flex: 1,
    padding: '20px',
    paddingBottom: 80,
  },
  bottomNav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'space-around',
    background: '#0a0e17',
    borderTop: '1px solid #1e2a3f',
    padding: '10px 0 20px',
  },
  navBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: 14,
    fontWeight: 500,
    padding: '8px 16px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
