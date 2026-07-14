import React, { useState, useEffect, useMemo } from 'react';
import {
  Activity, TrendingUp, TrendingDown, Zap, Radio, Layers, Settings,
  AlertTriangle, ChevronRight, CircleCheck, CircleX, Circle, Gauge,
  BarChart3, Brain, Newspaper, Globe2, Eye, Target, Clock, ArrowUpRight,
  ArrowDownRight, Minus, Shield, Cpu, LineChart as LineChartIcon, Filter, X,
  Inbox, Bell, ExternalLink, Info, BookMarked, Sparkles, Landmark, FlaskConical,
  Monitor, Menu, Crosshair
} from 'lucide-react';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, RadarChart,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer,
  XAxis, YAxis, Tooltip, Cell, ReferenceLine, CartesianGrid, Legend
} from 'recharts';
import { WilliamsView } from './WilliamsView.jsx';
import { LynchView } from './LynchView.jsx';
import { CatalystView } from './CatalystView.jsx';
import { ChartView } from './ChartView.jsx';
import { JournalView } from './JournalView.jsx';
import { ProphetView } from './ProphetView.jsx';
import { InsiderBoardView } from './InsiderBoardView.jsx';
import { HistoryView } from './HistoryView.jsx';
import { LogButton } from './components/LogButton.jsx';
import { UniverseSelector, UNIVERSE_AWARE_VIEWS } from './components/UniverseSelector.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { readLog, logTrade, removeTrade, computeForwardReturns } from './tradeLog.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { captureException } from './lib/sentry.js';
import { TargetBoardView, LiveTargetBoard } from './TargetBoardView.jsx';
import { DeskView } from './DeskView.jsx';
import { RegimeView } from './RegimeView.jsx';
import { AnalystsView } from './AnalystsView.jsx';
import { AlertsView } from './AlertsView.jsx';
import { EngineTestView } from './EngineTestView.jsx';
import { EarningsPlaysView } from './EarningsView.jsx';
import { FableView } from './FableView.jsx';
import { OptionsFlowView } from './OptionsFlowView.jsx';
import { SettingsView } from './SettingsView.jsx';
import { BacktestView } from './BacktestView.jsx';
import { ResearchPanel } from './components/ResearchPanel.jsx';
import { Logo, StatusDot, ConvictionBadge, DirectionPill } from './components/Badges.jsx';
import { fmt, safeTimestamp, tierColor, tierGlow, directionIcon, analystIcon, analystLabel } from './lib/formatters.jsx';
import { MOCK_REGIME, MOCK_TARGETS, MOCK_ANALYSTS, MOCK_ALERTS, MOCK_EQUITY_CURVE } from './lib/mockData.js';
import { useRegime } from './hooks/useRegime.js';
import { useEtClock } from './hooks/useEtClock.js';
import { useAnalystsStatus } from './hooks/useAnalystsStatus.js';
import { useBreakpoint } from './hooks/useBreakpoint.js';
import { Sidebar } from './layout/Sidebar.jsx';
import { DesktopShell } from './layout/DesktopShell.jsx';
import { RegimeStrip } from './layout/RegimeStrip.jsx';
import { MobileDrawer } from './layout/MobileDrawer.jsx';
import { CrossesView } from './CrossesView.jsx';


// FIX-1 — APP_VERSION now lives in the shared module so /api/health and
// the frontend report the same version. Bump it THERE.
import { APP_VERSION } from '../netlify/functions/shared/app-version';

// Phase 4k W1 — single navigation source-of-truth shared by the mobile
// TopBar and the desktop Sidebar. Mobile renders the same array as a
// horizontal scroller; desktop renders it as the vertical sidebar nav.
// FIX-1 W4 — verdict enforcement: Williams + Lynch measured NO VALIDATED
// EDGE (see netlify/functions/shared/verdicts.ts) and are demoted off the
// default nav into the trailing "Unvalidated" section. Target stays in
// place with a PENDING chip until the W3 composite runs land; its nav
// fate then follows the pre-committed rule in
// reports/fix-1/composite-verdict.md.
const VIEWS = [
  // DESK-1 — the trader workstation: tape + watchlist + focus dossier +
  // positions/base rates. Same VIEWS entry renders in the mobile TopBar
  // scroller AND the 4k Sidebar (Phase 4k single source of truth).
  { id: 'desk', label: 'Desk', shortLabel: 'Desk', icon: Monitor },
  // FABLE — Claude's own board (reports/fable/design.md). PENDING chip
  // until the pre-committed backtest lands; then the registry decides.
  { id: 'fable', label: 'FABLE', shortLabel: 'FABLE', icon: Sparkles },
  { id: 'prophet', label: 'Prophet', shortLabel: 'Prophet', icon: Sparkles },
  { id: 'catalyst', label: 'Catalyst', shortLabel: 'Catalyst', icon: Zap },
  { id: 'insiders', label: 'Insiders', shortLabel: 'Insiders', icon: Eye },
  { id: 'earnings', label: 'Earnings', shortLabel: 'Earnings', icon: Zap },
  // CROSSES — SMA50/200 golden + death cross feed, detected nightly on
  // completed closes (scan-crosses-sp500.ts → /api/crosses).
  { id: 'crosses', label: 'Crosses', shortLabel: 'Crosses', icon: Crosshair },
  { id: 'history', label: 'History', shortLabel: 'History', icon: Clock },
  { id: 'options', label: 'Options Flow', shortLabel: 'Options', icon: Cpu },
  { id: 'engine', label: 'Engine Test', shortLabel: 'Engine', icon: Activity },
  { id: 'backtest', label: 'Backtest', shortLabel: 'Backtest', icon: BarChart3 },
  { id: 'chart', label: 'Chart', shortLabel: 'Chart', icon: LineChartIcon },
  { id: 'regime', label: 'Regime', shortLabel: 'Regime', icon: Gauge },
  { id: 'analysts', label: 'Analysts', shortLabel: 'Analysts', icon: Brain },
  { id: 'alerts', label: 'Alerts', shortLabel: 'Alerts', icon: Bell },
  { id: 'journal', label: 'Journal', shortLabel: 'Journal', icon: BookMarked },
  { id: 'settings', label: 'Settings', shortLabel: 'Settings', icon: Settings },
  // FIX-1 W3 — the ten-analyst composite (Target Board) was measured with
  // NO VALIDATED EDGE (+33.7% vs SPY +107.9% = −74.2pp, IC −0.0105 over
  // 2018-2024; runId bt_20260711013530_q5qdh7). Per the pre-committed
  // rule in reports/fix-1/composite-verdict.md it demotes to a SCREENER:
  // moved out of the flagship/default position into the Unvalidated
  // section alongside Williams + Lynch. It stays in VIEWS (still
  // reachable as a screener); its VerdictChip now renders NO VALIDATED
  // EDGE automatically from verdicts.ts. FIX-2 (earnings) is the product.
  { id: 'board', label: 'Target Board', shortLabel: 'Board', icon: Target, section: 'unvalidated' },
  { id: 'williams', label: 'Williams', shortLabel: 'Williams', icon: Activity, section: 'unvalidated' },
  { id: 'lynch', label: 'Lynch', shortLabel: 'Lynch', icon: Shield, section: 'unvalidated' },
];

// ======================================================================
// ERROR BOUNDARY — catches React render errors in any child subtree and
// shows a recoverable fallback instead of white-screening the whole app.
// Wraps each main view so a crash in Prophet doesn't kill the Journal.
// ======================================================================
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    // Log to console so it shows up in remote debugging
    console.error('[ErrorBoundary]', this.props.label || 'unknown', error, info?.componentStack);
    // Forward to Sentry (no-op if VITE_SENTRY_DSN is unset).
    captureException(error, {
      boundary: this.props.label || 'unknown',
      componentStack: info?.componentStack,
      appVersion: APP_VERSION,
    });
  }
  reset = () => this.setState({ hasError: false, error: null });
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 sm:p-6 max-w-[800px] mx-auto">
          <div className="border border-rose-500/40 bg-rose-500/5 p-5">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-rose-400" />
              <div className="text-[11px] font-mono uppercase tracking-widest text-rose-400">
                Rendering error · {this.props.label || 'view'}
              </div>
            </div>
            <div className="text-[12px] text-neutral-300 mb-3 font-mono break-words">
              {String(this.state.error?.message || this.state.error || 'unknown error')}
            </div>
            <div className="text-[11px] text-neutral-500 mb-4">
              The rest of the app is still working. Tap below to try this view again, or switch to another tab.
            </div>
            <button
              onClick={this.reset}
              className="px-3 h-8 border border-neutral-700 text-[11px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              ↻ Reload view
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ======================================================================
// MOCK DATA — replaced by /api/target-board and Firestore subscriptions
// ======================================================================

const TopBar = ({ activeView, setActiveView, regime, universeStats }) => {
  // UI-2 — mobile nav is a drawer (hamburger → slide-in panel), replacing
  // the horizontal scroll-snap tab strip that hid most of the 20 views
  // off-screen. Desktop (sm+) keeps the inline nav row unchanged.
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  // code-review-2026-06 m6 — ticking ET clock (30s interval) instead of a
  // render-time snapshot that never updated.
  const etTime = useEtClock();

  const views = VIEWS;
  const activeMeta = views.find((v) => v.id === activeView);

  const regimeLabel = (regime?.regime ?? 'neutral').replace(/_/g, ' ').toUpperCase();

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800/80 bg-[#0a0b0d]/95 backdrop-blur-xl">
      {/* Row 1: hamburger (mobile) + logo + current view */}
      <div className="flex items-center h-11 sm:h-[52px] px-3 sm:px-6 gap-3">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          data-testid="nav-hamburger"
          className="sm:hidden p-2 -ml-2 text-neutral-400 active:text-neutral-100"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Logo />
        {/* Mobile: current view name so you always know where you are */}
        {activeMeta && (
          <div className="sm:hidden flex items-center gap-1.5 min-w-0 text-emerald-400">
            <activeMeta.icon className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="text-[13px] font-medium truncate">{activeMeta.label}</span>
          </div>
        )}
        {/* Desktop: inline nav (tabs fit on one row) */}
        <nav className="hidden sm:block flex-1 min-w-0 overflow-x-auto scrollbar-hide">
          <div className="flex items-center justify-end gap-1 whitespace-nowrap">
            {views.map((v, i) => (
              <React.Fragment key={v.id}>
                {v.section === 'unvalidated' && views[i - 1]?.section !== 'unvalidated' && (
                  <span
                    className="px-2 text-[9px] font-mono uppercase tracking-widest text-neutral-600 border-l border-neutral-800 ml-1 pl-3"
                    title="Boards with a measured NO VALIDATED EDGE verdict"
                  >
                    Unvalidated
                  </span>
                )}
                <button
                  onClick={() => setActiveView(v.id)}
                  className={`flex items-center gap-1.5 px-3 h-8 text-[13px] font-medium transition-all flex-shrink-0 ${
                    activeView === v.id
                      ? 'text-emerald-400 bg-emerald-500/10 border-b-2 border-emerald-400'
                      : v.section === 'unvalidated'
                        ? 'text-neutral-600 hover:text-neutral-400 border-b-2 border-transparent'
                        : 'text-neutral-400 hover:text-neutral-200 border-b-2 border-transparent'
                  }`}
                >
                  <v.icon className="h-3.5 w-3.5" />
                  {v.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        </nav>
      </div>

      {/* Mobile nav drawer (replaces the old horizontal scroll-snap tab row) */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        views={views}
        activeView={activeView}
        setActiveView={setActiveView}
        appVersion={APP_VERSION}
      />

      {/* Ticker-tape regime strip */}
      <div className="h-8 border-t border-neutral-800/60 bg-[#090a0c] text-[11px] font-mono overflow-x-auto scrollbar-hide">
        <div className="flex items-center h-full gap-3 sm:gap-6 px-3 sm:px-6 text-neutral-400 whitespace-nowrap min-w-max">
          <div className="flex items-center gap-2">
            <StatusDot status={regime?.regime === 'risk_off' ? 'warning' : 'healthy'} />
            <span className="uppercase tracking-wider">Regime</span>
            <span className={`font-medium ${
              regime?.regime === 'risk_on' ? 'text-emerald-400' :
              regime?.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'
            }`}>
              {regimeLabel}
            </span>
          </div>
          <span className="text-neutral-700">│</span>
          <div>VIX <span className="text-neutral-200">{regime?.vol?.level?.toFixed(1) ?? '—'}</span></div>
          <span className="text-neutral-700">│</span>
          <div>10Y <span className="text-neutral-200">{regime?.rates?.tenYear?.toFixed(2) ?? '—'}%</span></div>
          <span className="text-neutral-700">│</span>
          <div>2Y10Y <span className="text-neutral-200">{regime?.rates?.twoTenSpread ?? '—'}bp</span> <span className="text-neutral-500">{regime?.rates?.curveRegime ?? ''}</span></div>
          <span className="text-neutral-700">│</span>
          <div>
            <span className="uppercase tracking-wider">Universe</span>
            <span className="text-neutral-200 ml-1.5">{universeStats?.core || 0}</span>
            <span className="text-neutral-500 ml-1">core</span>
            {universeStats?.watchlist > 0 && (
              <>
                <span className="text-neutral-200 ml-2">{universeStats.watchlist}</span>
                <span className="text-neutral-500 ml-1">watch</span>
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 text-neutral-500">
            <Clock className="h-3 w-3" />
            <span>{etTime} ET</span>
          </div>
        </div>
      </div>
    </header>
  );
};

// ======================================================================
// TARGET BOARD (main view)
// ======================================================================

export default function App() {
  // FIX-1 W3 — default landing moved off the demoted Target Board (now a
  // screener in the Unvalidated section) to the Desk workstation.
  const [activeView, setActiveView] = useState('desk');
  const [universe, setUniverse] = useState('sp500');
  const showUniverseBar = UNIVERSE_AWARE_VIEWS.has(activeView);
  const { isDesktop } = useBreakpoint();

  // Live regime + analyst roster from the API. Both fall back gracefully
  // to MOCK_* on network/auth failure (TanStack returns `data: undefined`
  // and we substitute the mock so downstream components always have a
  // shape to render against).
  const { data: regimeData } = useRegime();
  const { data: analystsData } = useAnalystsStatus();
  const regimeIsMock = !regimeData?.regime;
  const analystsAreMock = !analystsData?.analysts?.length;
  const regime = regimeIsMock ? MOCK_REGIME : regimeData;
  const analysts = analystsAreMock ? MOCK_ANALYSTS : analystsData.analysts;

  // code-review-2026-06 m13 — the mock fallback stays (downstream
  // components always get a renderable shape) but it must never be
  // PRESENTED as live: surface a visible "demo data" banner whenever a
  // mock is what's on screen.
  const demoBanner = (regimeIsMock || analystsAreMock) && (
    <div
      data-testid="demo-data-banner"
      className="border-b border-amber-500/30 bg-amber-500/10 text-amber-300 text-[10px] font-mono uppercase tracking-widest text-center py-1"
    >
      demo data — live {regimeIsMock && analystsAreMock
        ? 'regime + analyst feeds'
        : regimeIsMock ? 'regime feed' : 'analyst feed'} unavailable
    </div>
  );

  // Phase 4k W1 — content body shared by the mobile and desktop shells.
  // The universe selector and the view router are identical across
  // breakpoints; only the chrome around them (TopBar vs Sidebar +
  // DesktopShell) changes.
  const universeBar = showUniverseBar && (
    <div className={
      isDesktop
        ? 'sticky top-8 z-20 border-b border-neutral-800/60 bg-[#0a0b0d]/95 backdrop-blur-xl'
        : 'sticky top-[76px] sm:top-[92px] z-30 border-b border-neutral-800/60 bg-[#0a0b0d]/95 backdrop-blur-xl'
    }>
      <div className={isDesktop ? 'px-6 py-2' : 'px-3 sm:px-6 py-2 max-w-[1400px] mx-auto'}>
        <UniverseSelector universe={universe} setUniverse={setUniverse} />
      </div>
    </div>
  );

  const viewRouter = (
    <>
      {activeView === 'desk' && <ErrorBoundary label="Desk"><DeskView /></ErrorBoundary>}
      {activeView === 'fable' && <ErrorBoundary label="FABLE"><FableView /></ErrorBoundary>}
      {activeView === 'board' && <ErrorBoundary label="Board"><LiveTargetBoard universe={universe} /></ErrorBoundary>}
      {activeView === 'prophet' && <ErrorBoundary label="Prophet"><ProphetView /></ErrorBoundary>}
      {activeView === 'catalyst' && <ErrorBoundary label="Catalyst"><CatalystView universe={universe} onNavigate={setActiveView} /></ErrorBoundary>}
      {activeView === 'insiders' && <ErrorBoundary label="Insiders"><InsiderBoardView universe={universe} /></ErrorBoundary>}
      {activeView === 'williams' && <ErrorBoundary label="Williams"><WilliamsView universe={universe} /></ErrorBoundary>}
      {activeView === 'lynch' && <ErrorBoundary label="Lynch"><LynchView universe={universe} /></ErrorBoundary>}
      {activeView === 'earnings' && <ErrorBoundary label="Earnings"><EarningsPlaysView universe={universe} /></ErrorBoundary>}
      {activeView === 'crosses' && <ErrorBoundary label="Crosses"><CrossesView /></ErrorBoundary>}
      {activeView === 'history' && <ErrorBoundary label="History"><HistoryView /></ErrorBoundary>}
      {activeView === 'options' && <ErrorBoundary label="Options"><OptionsFlowView universe={universe} /></ErrorBoundary>}
      {activeView === 'engine' && <ErrorBoundary label="Engine"><EngineTestView /></ErrorBoundary>}
      {activeView === 'backtest' && <ErrorBoundary label="Backtest"><BacktestView /></ErrorBoundary>}
      {activeView === 'chart' && <ErrorBoundary label="Chart"><ChartView /></ErrorBoundary>}
      {activeView === 'regime' && <ErrorBoundary label="Regime"><RegimeView regime={regime} /></ErrorBoundary>}
      {activeView === 'analysts' && <ErrorBoundary label="Analysts"><AnalystsView analysts={analysts} /></ErrorBoundary>}
      {activeView === 'alerts' && <ErrorBoundary label="Alerts"><AlertsView /></ErrorBoundary>}
      {activeView === 'journal' && <ErrorBoundary label="Journal"><JournalView /></ErrorBoundary>}
      {activeView === 'settings' && <ErrorBoundary label="Settings"><SettingsView /></ErrorBoundary>}
    </>
  );

  const footer = (
    <footer className="mt-16 py-6 border-t border-neutral-900 text-center">
      <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-neutral-600">
        TradeIQ Alpha · Personal · Not Financial Advice · v{APP_VERSION}
      </div>
    </footer>
  );

  const fontsAndScrollbars = (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&family=Sora:wght@300;400;500;600&display=swap');
      body { font-family: 'Sora', system-ui, sans-serif; }
      .font-serif { font-family: 'IBM Plex Serif', Georgia, serif; }
      .font-mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
      .tabular-nums { font-variant-numeric: tabular-nums; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: #0a0b0d; }
      ::-webkit-scrollbar-thumb { background: #2a2b2e; }
      ::-webkit-scrollbar-thumb:hover { background: #3a3b3e; }
    `}</style>
  );

  const rootStyle = {
    fontFamily: '"Sora", system-ui, sans-serif',
    backgroundImage: `
      radial-gradient(ellipse at top, rgba(20, 232, 154, 0.04) 0%, transparent 45%),
      radial-gradient(ellipse at bottom, rgba(77, 186, 242, 0.02) 0%, transparent 45%)
    `,
  };

  if (isDesktop) {
    return (
      <div className="min-h-screen bg-[#050607] text-neutral-200" style={rootStyle}>
        {fontsAndScrollbars}
        <DesktopShell
          sidebar={
            <Sidebar
              views={VIEWS}
              activeView={activeView}
              setActiveView={setActiveView}
              appVersion={APP_VERSION}
            />
          }
          topStrip={<RegimeStrip regime={regime} universeStats={{ core: 784, watchlist: 12 }} />}
        >
          {demoBanner}
          {universeBar}
          {viewRouter}
          {footer}
        </DesktopShell>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050607] text-neutral-200 overflow-x-hidden" style={rootStyle}>
      {fontsAndScrollbars}

      <TopBar
        activeView={activeView}
        setActiveView={setActiveView}
        regime={regime}
        universeStats={{ core: 784, watchlist: 12 }}
      />

      {demoBanner}

      {universeBar}

      <main>{viewRouter}</main>

      {footer}
    </div>
  );
}
