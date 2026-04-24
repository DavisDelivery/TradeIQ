import React, { useState, useEffect, useMemo } from 'react';
import {
  Activity, TrendingUp, TrendingDown, Zap, Radio, Layers, Settings,
  AlertTriangle, ChevronRight, CircleCheck, CircleX, Circle, Gauge,
  BarChart3, Brain, Newspaper, Globe2, Eye, Target, Clock, ArrowUpRight,
  ArrowDownRight, Minus, Shield, Cpu, LineChart as LineChartIcon, Filter, X,
  Inbox, Bell, ExternalLink, Info, BookMarked, Sparkles
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
import { LogButton } from './components/LogButton.jsx';
import { UniverseSelector, UNIVERSE_AWARE_VIEWS } from './components/UniverseSelector.jsx';
import { readLog, logTrade, removeTrade, computeForwardReturns } from './tradeLog.js';
import { validate, SHAPES } from './lib/validateResponse.js';

const APP_VERSION = '0.7.16-alpha';

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

const MOCK_REGIME = {
  regime: 'risk_on',
  conviction: 'medium',
  vol: { level: 13.8, regime: 'low', trend: 'falling', percentile: 18 },
  rates: { tenYear: 4.12, twoTenSpread: 22, curveRegime: 'normal', trend: 'stable' },
  riskAppetite: { ratioTrend: 'risk_on_rising', creditSignal: 'tightening_spreads' },
  rationale: 'Risk-on regime (medium): VIX 13.8 (low, falling), 2y10y normal 22bp, risk on rising, tightening spreads',
  computedAt: new Date().toISOString(),
};

const MOCK_TARGETS = [
  {
    ticker: 'NVDA', composite: 91, tier: 'A', direction: 'long',
    price: 898.40, priceChangePct: 2.8,
    rationale: 'Net long: 6 analysts aligned bullish. Earnings setup, unusual call flow $1.8M premium, positive news cluster (AI demand theme), sector leadership in XLK #1 sector, 20d breakout on 2.8x volume.',
    analystContributions: [
      { analyst: 'technical-analyst', score: 88, direction: 'long', weight: 0.15 },
      { analyst: 'flow-analyst', score: 95, direction: 'long', weight: 0.15 },
      { analyst: 'news-sentiment', score: 89, direction: 'long', weight: 0.15 },
      { analyst: 'fundamental-analyst', score: 82, direction: 'long', weight: 0.15 },
      { analyst: 'sector-rotation', score: 85, direction: 'long', weight: 0.10 },
      { analyst: 'earnings-analyst', score: 87, direction: 'neutral', weight: 0.15 },
      { analyst: 'macro-regime', score: 70, direction: 'long', weight: 0.10 },
    ],
    topSignals: [
      { type: 'unusual_call_activity', score: 95 },
      { type: 'positive_news_cluster', score: 89 },
      { type: 'bullish_breakout', score: 88 },
    ],
    conflictLevel: 'none',
    scoredAt: new Date().toISOString(),
  },
  {
    ticker: 'TSLA', composite: 82, tier: 'B', direction: 'short',
    price: 242.10, priceChangePct: -3.4,
    rationale: 'Net short: 4 analysts bearish. Bearish breakdown on 2.1x volume, negative sentiment cluster (delivery miss), sector laggard in XLY, unusual put flow at 220/210 strikes.',
    analystContributions: [
      { analyst: 'technical-analyst', score: 81, direction: 'short', weight: 0.15 },
      { analyst: 'flow-analyst', score: 78, direction: 'short', weight: 0.15 },
      { analyst: 'news-sentiment', score: 80, direction: 'short', weight: 0.15 },
      { analyst: 'sector-rotation', score: 68, direction: 'short', weight: 0.10 },
      { analyst: 'fundamental-analyst', score: 62, direction: 'short', weight: 0.15 },
    ],
    topSignals: [
      { type: 'bearish_breakdown', score: 81 },
      { type: 'negative_news_cluster', score: 80 },
    ],
    conflictLevel: 'none',
    scoredAt: new Date().toISOString(),
  },
  {
    ticker: 'XOM', composite: 78, tier: 'B', direction: 'long',
    price: 118.60, priceChangePct: 1.4,
    rationale: 'Geopolitical tailwind (Middle East tensions → energy), XLE sector leadership, insider buying cluster, strong technicals.',
    analystContributions: [
      { analyst: 'geopolitical-analyst', score: 88, direction: 'long', weight: 0.05 },
      { analyst: 'sector-rotation', score: 85, direction: 'long', weight: 0.10 },
      { analyst: 'flow-analyst', score: 76, direction: 'long', weight: 0.15 },
      { analyst: 'technical-analyst', score: 74, direction: 'long', weight: 0.15 },
    ],
    topSignals: [
      { type: 'geo_tailwind', score: 88 },
      { type: 'sector_leadership', score: 85 },
      { type: 'insider_buying', score: 76 },
    ],
    conflictLevel: 'none',
    scoredAt: new Date().toISOString(),
  },
  {
    ticker: 'SMH', composite: 76, tier: 'B', direction: 'long',
    price: 248.80, priceChangePct: 1.8,
    rationale: 'Semi sector broad strength, breakout above 20d high, analyst revisions trending up across holdings.',
    analystContributions: [
      { analyst: 'technical-analyst', score: 82, direction: 'long', weight: 0.15 },
      { analyst: 'sector-rotation', score: 78, direction: 'long', weight: 0.10 },
      { analyst: 'fundamental-analyst', score: 74, direction: 'long', weight: 0.15 },
    ],
    topSignals: [{ type: 'bullish_breakout', score: 82 }],
    conflictLevel: 'none',
    scoredAt: new Date().toISOString(),
  },
  {
    ticker: 'AAPL', composite: 72, tier: 'C', direction: 'long',
    price: 188.40, priceChangePct: 0.6,
    rationale: 'Pullback to 20MA bouncing, trend intact, moderate sentiment, but mild conflict with macro headwinds.',
    analystContributions: [
      { analyst: 'technical-analyst', score: 76, direction: 'long', weight: 0.15 },
      { analyst: 'sector-rotation', score: 64, direction: 'long', weight: 0.10 },
      { analyst: 'fundamental-analyst', score: 68, direction: 'long', weight: 0.15 },
    ],
    topSignals: [{ type: 'trend_continuation', score: 76 }],
    conflictLevel: 'mild',
    scoredAt: new Date().toISOString(),
  },
  {
    ticker: 'KRE', composite: 71, tier: 'C', direction: 'short',
    price: 52.80, priceChangePct: -1.2,
    rationale: 'Regional banks underperforming broadly, yield curve pressure, negative news cluster on deposit outflows.',
    analystContributions: [
      { analyst: 'sector-rotation', score: 75, direction: 'short', weight: 0.10 },
      { analyst: 'news-sentiment', score: 72, direction: 'short', weight: 0.15 },
      { analyst: 'technical-analyst', score: 68, direction: 'short', weight: 0.15 },
    ],
    topSignals: [{ type: 'sector_laggard', score: 75 }],
    conflictLevel: 'none',
    scoredAt: new Date().toISOString(),
  },
];

const MOCK_ANALYSTS = [
  { name: 'technical-analyst', label: 'Technical', signalsToday: 142, accuracy7d: 0.68, cost: 0, status: 'healthy' },
  { name: 'sector-rotation', label: 'Sector Rotation', signalsToday: 68, accuracy7d: 0.64, cost: 0, status: 'healthy' },
  { name: 'fundamental-analyst', label: 'Fundamental', signalsToday: 31, accuracy7d: 0.72, cost: 0, status: 'healthy' },
  { name: 'news-sentiment', label: 'News Sentiment', signalsToday: 89, accuracy7d: 0.58, cost: 1.85, status: 'healthy' },
  { name: 'flow-analyst', label: 'Flow', signalsToday: 47, accuracy7d: 0.75, cost: 0, status: 'healthy' },
  { name: 'earnings-analyst', label: 'Earnings', signalsToday: 12, accuracy7d: 0.71, cost: 0, status: 'healthy' },
  { name: 'geopolitical-analyst', label: 'Geopolitical', signalsToday: 23, accuracy7d: 0.52, cost: 0.45, status: 'healthy' },
  { name: 'macro-regime', label: 'Macro Regime', signalsToday: 1, accuracy7d: null, cost: 0, status: 'healthy' },
];

const MOCK_ALERTS = [
  { id: 1, ticker: 'NVDA', tier: 'A', composite: 91, direction: 'long', firedAt: new Date(Date.now() - 14400000).toISOString(), delivered: true },
  { id: 2, ticker: 'TSLA', tier: 'A', composite: 90, direction: 'short', firedAt: new Date(Date.now() - 86400000).toISOString(), delivered: true },
  { id: 3, ticker: 'META', tier: 'A', composite: 93, direction: 'long', firedAt: new Date(Date.now() - 172800000).toISOString(), delivered: true },
];

const MOCK_EQUITY_CURVE = Array.from({ length: 60 }, (_, i) => ({
  day: i,
  date: new Date(Date.now() - (60 - i) * 86400000).toISOString().slice(5, 10),
  equity: 10000 + Math.sin(i / 6) * 600 + i * 35 + (Math.random() - 0.5) * 200,
}));

// ======================================================================
// UTILITIES
// ======================================================================

const fmt = {
  pct: (n, d = 1) => {
    if (n == null || !Number.isFinite(n)) return '—';
    return `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
  },
  money: (n) => {
    if (n == null || !Number.isFinite(n)) return '—';
    return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  },
  moneyDec: (n) => {
    if (n == null || !Number.isFinite(n)) return '—';
    return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
  },
};

// Safe timestamp formatter — tolerates invalid or missing dates
const safeTimestamp = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
};

const tierColor = (tier) => ({
  A: '#14e89a', B: '#4dbaf2', C: '#ffb020', D: '#5a6373'
}[tier] || '#5a6373');

const tierGlow = (tier) => ({
  A: '0 0 24px -4px #14e89a77', B: '0 0 16px -4px #4dbaf255', C: '', D: ''
}[tier] || '');

const directionIcon = (d) =>
  d === 'long' ? <ArrowUpRight className="h-3 w-3" /> :
  d === 'short' ? <ArrowDownRight className="h-3 w-3" /> :
  <Minus className="h-3 w-3" />;

const analystIcon = {
  'technical-analyst': LineChartIcon,
  'sector-rotation': Layers,
  'fundamental-analyst': BarChart3,
  'news-sentiment': Newspaper,
  'flow-analyst': Cpu,
  'earnings-analyst': Zap,
  'geopolitical-analyst': Globe2,
  'macro-regime': Gauge,
};

const analystLabel = {
  'technical-analyst': 'Technical',
  'sector-rotation': 'Sector',
  'fundamental-analyst': 'Fundamental',
  'news-sentiment': 'News',
  'flow-analyst': 'Flow',
  'earnings-analyst': 'Earnings',
  'geopolitical-analyst': 'Geo',
  'macro-regime': 'Macro',
};

// ======================================================================
// SHARED COMPONENTS
// ======================================================================

const Logo = () => (
  <div className="flex items-center gap-3">
    <div className="relative">
      <div className="h-9 w-9 border border-emerald-500/30 bg-emerald-500/5 flex items-center justify-center">
        <div className="text-emerald-400 font-serif font-bold text-xs tracking-tight">α</div>
      </div>
      <div className="absolute -top-1 -right-1 h-1.5 w-1.5 bg-emerald-400 rounded-full animate-pulse" />
    </div>
    <div className="leading-tight">
      <div className="font-serif font-bold text-base tracking-[-0.01em]">
        TradeIQ <span className="text-emerald-400 italic font-light">Alpha</span>
      </div>
      <div className="text-[10px] text-neutral-500 font-mono tracking-wider uppercase mt-0.5">
        multi-factor · {APP_VERSION}
      </div>
    </div>
  </div>
);

const StatusDot = ({ status = 'healthy' }) => {
  const color = status === 'healthy' ? 'bg-emerald-400' : status === 'warning' ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="relative h-1.5 w-1.5 flex items-center justify-center">
      <div className={`h-1.5 w-1.5 ${color} rounded-full`} />
      <div className={`absolute h-1.5 w-1.5 ${color} rounded-full animate-ping opacity-50`} />
    </div>
  );
};

const ConvictionBadge = ({ tier }) => (
  <div className="inline-flex items-center gap-1.5">
    <div
      className="h-5 w-5 flex items-center justify-center text-[10px] font-bold font-mono border"
      style={{ color: tierColor(tier), borderColor: tierColor(tier) + '66', background: tierColor(tier) + '15' }}
    >
      {tier}
    </div>
  </div>
);

const DirectionPill = ({ direction }) => {
  const cls = direction === 'long'
    ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
    : direction === 'short'
    ? 'text-rose-300 border-rose-500/30 bg-rose-500/10'
    : 'text-neutral-300 border-neutral-700 bg-neutral-900';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${cls}`}>
      {directionIcon(direction)}
      {direction}
    </span>
  );
};

// ======================================================================
// TOP BAR
// ======================================================================

const TopBar = ({ activeView, setActiveView, regime, universeStats }) => {
  const scrollerRef = React.useRef(null);
  const buttonRefs = React.useRef({});

  const views = [
    { id: 'board', label: 'Target Board', shortLabel: 'Board', icon: Target },
    { id: 'prophet', label: 'Prophet', shortLabel: 'Prophet', icon: Sparkles },
    { id: 'catalyst', label: 'Catalyst', shortLabel: 'Catalyst', icon: Zap },
    { id: 'williams', label: 'Williams', shortLabel: 'Williams', icon: Activity },
    { id: 'lynch', label: 'Lynch', shortLabel: 'Lynch', icon: Shield },
    { id: 'earnings', label: 'Earnings', shortLabel: 'Earnings', icon: Zap },
    { id: 'options', label: 'Options Flow', shortLabel: 'Options', icon: Cpu },
    { id: 'engine', label: 'Engine Test', shortLabel: 'Engine', icon: Activity },
    { id: 'backtest', label: 'Backtest', shortLabel: 'Backtest', icon: BarChart3 },
    { id: 'chart', label: 'Chart', shortLabel: 'Chart', icon: LineChartIcon },
    { id: 'regime', label: 'Regime', shortLabel: 'Regime', icon: Gauge },
    { id: 'analysts', label: 'Analysts', shortLabel: 'Analysts', icon: Brain },
    { id: 'alerts', label: 'Alerts', shortLabel: 'Alerts', icon: Bell },
    { id: 'journal', label: 'Journal', shortLabel: 'Journal', icon: BookMarked },
    { id: 'settings', label: 'Settings', shortLabel: 'Settings', icon: Settings },
  ];

  // Auto-scroll the active tab into view (center it) whenever activeView changes
  React.useEffect(() => {
    const btn = buttonRefs.current[activeView];
    if (btn && btn.scrollIntoView) {
      btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [activeView]);

  const regimeLabel = (regime?.regime ?? 'neutral').replace(/_/g, ' ').toUpperCase();

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800/80 bg-[#0a0b0d]/95 backdrop-blur-xl">
      {/* Row 1: Logo (mobile-sized) */}
      <div className="flex items-center h-10 sm:h-[52px] px-3 sm:px-6 gap-3 border-b border-neutral-800/40 sm:border-b-0">
        <Logo />
        {/* Desktop: inline nav (tabs fit on one row) */}
        <nav className="hidden sm:block flex-1 min-w-0 overflow-x-auto scrollbar-hide">
          <div className="flex items-center justify-end gap-1 whitespace-nowrap">
            {views.map(v => (
              <button
                key={v.id}
                onClick={() => setActiveView(v.id)}
                className={`flex items-center gap-1.5 px-3 h-8 text-[13px] font-medium transition-all flex-shrink-0 ${
                  activeView === v.id
                    ? 'text-emerald-400 bg-emerald-500/10 border-b-2 border-emerald-400'
                    : 'text-neutral-400 hover:text-neutral-200 border-b-2 border-transparent'
                }`}
              >
                <v.icon className="h-3.5 w-3.5" />
                {v.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      {/* Row 2 (mobile only): horizontal scroll-snap tabs — same pattern as old bottom nav */}
      <div className="sm:hidden relative">
        <div className="absolute left-0 top-0 bottom-0 w-5 pointer-events-none z-10 bg-gradient-to-r from-[#0a0b0d] to-transparent" />
        <div className="absolute right-0 top-0 bottom-0 w-5 pointer-events-none z-10 bg-gradient-to-l from-[#0a0b0d] to-transparent" />
        <div
          ref={scrollerRef}
          className="flex w-full overflow-x-auto snap-x snap-mandatory"
          style={{
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            WebkitOverflowScrolling: 'touch',
            scrollPaddingInline: '20px',
          }}
        >
          <style>{`header > div > div::-webkit-scrollbar{display:none}`}</style>
          {views.map(v => {
            const active = activeView === v.id;
            return (
              <button
                key={v.id}
                ref={(el) => { buttonRefs.current[v.id] = el; }}
                onClick={() => setActiveView(v.id)}
                className={`relative shrink-0 snap-center flex items-center justify-center gap-1.5 h-11 px-3.5 transition-colors ${
                  active
                    ? 'text-emerald-400'
                    : 'text-neutral-500 active:text-neutral-300'
                }`}
              >
                {active && (
                  <span className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[2px] w-7 bg-emerald-400 rounded-t-full" />
                )}
                <v.icon className={`h-[14px] w-[14px] flex-shrink-0 ${active ? 'stroke-[2.2]' : ''}`} />
                <span className="text-[12px] font-medium tracking-tight whitespace-nowrap">{v.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </div>

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
            <span>
              {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} ET
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};

// ======================================================================
// TARGET BOARD (main view)
// ======================================================================

const TargetCard = ({ target, onOpen }) => {
  const conflict = target.conflictLevel && target.conflictLevel !== 'none';
  return (
    <button
      onClick={() => onOpen(target)}
      className="group relative text-left w-full border border-neutral-800/80 bg-neutral-950/40 hover:bg-neutral-900/60 hover:border-neutral-700 transition-all duration-200 overflow-hidden"
      style={target.tier === 'A' ? { boxShadow: tierGlow('A') } : {}}
    >
      {/* Tier accent stripe */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: tierColor(target.tier) }} />

      <div className="p-4 pl-5">
        {/* Top row: ticker + composite */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-baseline gap-2">
              <div className="font-serif font-bold text-xl tracking-tight text-neutral-100">
                {target.ticker}
              </div>
              <DirectionPill direction={target.direction} />
            </div>
            <div className="text-[11px] text-neutral-500 font-mono mt-1">
              <span className="text-neutral-300">{fmt.moneyDec(target.price)}</span>
              <span className={`ml-2 ${target.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmt.pct(target.priceChangePct)}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <ConvictionBadge tier={target.tier} />
            <div className="text-right">
              <div className="font-mono tabular-nums text-2xl font-semibold" style={{ color: tierColor(target.tier) }}>
                {target.composite}
              </div>
              <div className="text-[9px] text-neutral-500 font-mono uppercase tracking-widest mt-0.5">composite</div>
            </div>
          </div>
        </div>

        {/* Analyst dots */}
        <div className="flex items-center gap-1 mb-3">
          {target.analystContributions?.slice(0, 8).map((c) => {
            const Icon = analystIcon[c.analyst] || Circle;
            const color = c.direction === 'long' ? '#14e89a' : c.direction === 'short' ? '#ff5577' : '#9ca3af';
            return (
              <div
                key={c.analyst}
                className="relative group/dot"
                title={`${analystLabel[c.analyst]}: ${c.score} ${c.direction}`}
              >
                <div
                  className="h-5 w-5 border flex items-center justify-center"
                  style={{
                    borderColor: color + '55',
                    background: color + '15',
                    color,
                  }}
                >
                  <Icon className="h-2.5 w-2.5" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Rationale */}
        <p className="text-[12px] text-neutral-400 leading-relaxed line-clamp-3">
          {target.rationale}
        </p>

        {/* Conflict indicator if any */}
        {conflict && (
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-amber-400/70 font-mono uppercase tracking-wider">
            <AlertTriangle className="h-3 w-3" />
            {target.conflictLevel} conflict · score penalized
          </div>
        )}
      </div>
    </button>
  );
};

const LiveTargetBoard = ({ onOpenTarget, universe = 'all' }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const requestIdRef = React.useRef(0);

  const load = async () => {
    const myId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/target-board?limit=50&universe=${universe}`);
      const json = await r.json();
      // Drop stale response if user has since tapped a different universe
      if (myId !== requestIdRef.current) return;
      if (!r.ok || json.error) {
        setError(json.error || `HTTP ${r.status}`);
      } else {
        setData(validate(json, SHAPES.targetBoard, "target-board"));
      }
    } catch (err) {
      if (myId === requestIdRef.current) setError(err.message);
    } finally {
      if (myId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [universe]);

  if (loading && !data) {
    const universeMeta = {
      core: { label: 'core watchlist', size: 33, time: '10-15s' },
      sp500: { label: 'S&P 500', size: 500, time: '20-35s, two-pass' },
      ndx: { label: 'Nasdaq 100', size: 100, time: '15-25s' },
      dow: { label: 'Dow 30', size: 30, time: '10-15s' },
      russell: { label: 'Russell 2000', size: 2000, time: '30-50s, two-pass' },
      russell2k: { label: 'Russell 2000', size: 2000, time: '30-50s, two-pass' },
      all: { label: 'all indices', size: 2500, time: '40-60s, two-pass' },
    };
    const m = universeMeta[universe] || universeMeta.all;
    return (
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Scanning {m.label} ({m.size.toLocaleString()} tickers)…</div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">{m.time} · Polygon bars + sector rotation + aggregation</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-4">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-1">
            <CircleX className="h-4 w-4" /> Error loading target board
          </div>
          <div className="text-[12px] text-neutral-300">{error}</div>
          <button onClick={load} className="mt-3 px-3 h-8 border border-neutral-800 text-[11px] font-mono uppercase tracking-widest text-neutral-400 hover:text-neutral-200">
            ↻ Retry
          </button>
        </div>
      </div>
    );
  }

  const targets = data?.targets || [];
  return (
    <>
      <TargetBoardView targets={targets} onOpenTarget={onOpenTarget} scanMeta={data} />
      {data && (
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 pb-6 text-[10px] font-mono text-neutral-600 flex items-center gap-3">
          <span>Source: <span className="text-neutral-400">{data.source}</span></span>
          <span>·</span>
          <span>Generated: <span className="text-neutral-400">{safeTimestamp(data.generatedAt)}</span></span>
          <span>·</span>
          <span>{targets.length} targets</span>
          <button onClick={load} className="ml-auto px-2 h-6 border border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-500 hover:text-neutral-300">
            ↻ Refresh
          </button>
        </div>
      )}
    </>
  );
};

const TargetBoardView = ({ targets, onOpenTarget, scanMeta }) => {
  const [filterTier, setFilterTier] = useState('all');
  const [filterDirection, setFilterDirection] = useState('all');

  const filtered = useMemo(() => {
    return targets
      .filter(t => filterTier === 'all' || t.tier === filterTier)
      .filter(t => filterDirection === 'all' || t.direction === filterDirection)
      .sort((a, b) => b.composite - a.composite);
  }, [targets, filterTier, filterDirection]);

  const breakdown = useMemo(() => ({
    A: targets.filter(t => t.tier === 'A').length,
    B: targets.filter(t => t.tier === 'B').length,
    C: targets.filter(t => t.tier === 'C').length,
    long: targets.filter(t => t.direction === 'long').length,
    short: targets.filter(t => t.direction === 'short').length,
  }), [targets]);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      {/* Header strip */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-5 sm:mb-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Live Board</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {filtered.length} <span className="text-neutral-500 italic font-light">targets ranked</span>
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] font-mono text-neutral-400">
            {scanMeta?.universe && (
              <div>
                <span className="text-neutral-500 uppercase tracking-widest mr-2">Scope</span>
                <span className="text-neutral-200 font-semibold">
                  {scanMeta.universe === 'core' ? 'Core (33)' :
                    scanMeta.universe === 'sp500' ? 'S&P 500' :
                    scanMeta.universe === 'ndx' ? 'Nasdaq 100' :
                    scanMeta.universe === 'dow' ? 'Dow 30' :
                    (scanMeta.universe === 'russell' || scanMeta.universe === 'russell2k') ? 'Russell 2K' :
                    'All Indices'}
                </span>
                {scanMeta.tickersScanned !== undefined && (
                  <span className="text-neutral-500 ml-1">
                    · {scanMeta.tickersScanned}/{scanMeta.universeSize ?? scanMeta.tickersScanned} scanned
                  </span>
                )}
              </div>
            )}
            <div>
              <span className="text-neutral-500 uppercase tracking-widest mr-2">A-grade</span>
              <span className="text-emerald-400 font-semibold">{breakdown.A}</span>
            </div>
            <div>
              <span className="text-neutral-500 uppercase tracking-widest mr-2">B-grade</span>
              <span className="text-sky-400 font-semibold">{breakdown.B}</span>
            </div>
            <div>
              <span className="text-neutral-500 uppercase tracking-widest mr-2">Long/Short</span>
              <span className="text-emerald-400">{breakdown.long}</span>
              <span className="text-neutral-600 mx-1">/</span>
              <span className="text-rose-400">{breakdown.short}</span>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1 text-[11px] font-mono">
            <span className="text-neutral-500 mr-2 uppercase tracking-widest">Tier</span>
            {['all', 'A', 'B', 'C'].map(t => (
              <button
                key={t}
                onClick={() => setFilterTier(t)}
                className={`px-2 h-7 ${
                  filterTier === t ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {t === 'all' ? 'ALL' : t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[11px] font-mono">
            <span className="text-neutral-500 mr-2 uppercase tracking-widest">Side</span>
            {['all', 'long', 'short'].map(d => (
              <button
                key={d}
                onClick={() => setFilterDirection(d)}
                className={`px-2 h-7 uppercase ${
                  filterDirection === d ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(t => (
          <TargetCard key={t.ticker} target={t} onOpen={onOpenTarget} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="border border-neutral-800 p-16 text-center">
          <Filter className="h-6 w-6 mx-auto text-neutral-600 mb-3" />
          <div className="text-neutral-400">No targets match filters</div>
        </div>
      )}
    </div>
  );
};

// ======================================================================
// TARGET DETAIL MODAL
// ======================================================================

const TargetDetail = ({ target, onClose }) => {
  if (!target) return null;

  // Radar chart data from analyst contributions
  const radarData = target.analystContributions?.map(c => ({
    subject: analystLabel[c.analyst] || c.analyst,
    score: c.score,
    fullMark: 100,
  })) || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-5xl max-h-[92vh] overflow-y-auto bg-[#0a0b0d] border border-neutral-800"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#0a0b0d] border-b border-neutral-800 px-6 py-4 flex items-center justify-between">
          <div>
            <div className="flex items-baseline gap-4">
              <h2 className="font-serif font-bold text-3xl tracking-tight">{target.ticker}</h2>
              <ConvictionBadge tier={target.tier} />
              <DirectionPill direction={target.direction} />
            </div>
            <div className="mt-1 font-mono text-[12px] text-neutral-400">
              <span className="text-neutral-200">{fmt.moneyDec(target.price)}</span>
              <span className={`ml-2 ${target.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmt.pct(target.priceChangePct)}
              </span>
              <span className="text-neutral-600 mx-2">│</span>
              <span>Composite <span className="font-semibold" style={{ color: tierColor(target.tier) }}>{target.composite}</span></span>
              {target.scoredAt && (
                <>
                  <span className="text-neutral-600 mx-2">│</span>
                  <span className="text-neutral-500">Scored {new Date(target.scoredAt).toLocaleTimeString()}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LogButton
              size="md"
              payload={{
                ticker: target.ticker,
                source: 'board',
                loggedPrice: target.price,
                composite: target.composite,
                tier: target.tier,
                direction: target.direction,
                rationale: target.rationale,
              }}
            />
            <button onClick={onClose} className="text-neutral-400 hover:text-neutral-200 p-1">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Rationale */}
          <div className="border-l-2 border-emerald-500/40 pl-4 py-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Thesis</div>
            <p className="text-neutral-200 leading-relaxed">{target.rationale}</p>
          </div>

          {/* AI Research Brief (on-demand) */}
          <ResearchPanel ticker={target.ticker} />

          {/* Analyst radar + contributions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-neutral-800 p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Analyst Agreement</div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radarData}>
                    <PolarGrid stroke="#2a2b2e" />
                    <PolarAngleAxis
                      dataKey="subject"
                      tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'IBM Plex Mono' }}
                    />
                    <PolarRadiusAxis
                      domain={[0, 100]}
                      tick={{ fill: '#525252', fontSize: 9 }}
                      stroke="#2a2b2e"
                    />
                    <Radar
                      dataKey="score"
                      stroke="#14e89a"
                      fill="#14e89a"
                      fillOpacity={0.2}
                      strokeWidth={1.5}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="border border-neutral-800 p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Contributions</div>
              <div className="space-y-2">
                {target.analystContributions?.map(c => {
                  const Icon = analystIcon[c.analyst] || Circle;
                  const color = c.direction === 'long' ? 'text-emerald-400' : c.direction === 'short' ? 'text-rose-400' : 'text-neutral-400';
                  return (
                    <div key={c.analyst} className="flex items-center gap-3">
                      <Icon className={`h-3.5 w-3.5 ${color}`} />
                      <div className="flex-1 text-[12px] font-mono text-neutral-300">{analystLabel[c.analyst]}</div>
                      <div className="flex items-center gap-2 flex-1">
                        <div className="flex-1 h-1 bg-neutral-800">
                          <div
                            className="h-full"
                            style={{ width: `${c.score}%`, background: c.direction === 'long' ? '#14e89a' : c.direction === 'short' ? '#ff5577' : '#9ca3af' }}
                          />
                        </div>
                        <span className={`font-mono text-[12px] w-8 text-right ${color}`}>{c.score}</span>
                      </div>
                      <span className="font-mono text-[10px] text-neutral-500 w-10 text-right uppercase">{Number.isFinite(c.weight) ? `${(c.weight * 100).toFixed(0)}%` : '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Top signals */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Top Signals</div>
            <div className="flex flex-wrap gap-2">
              {target.topSignals?.map((s, i) => (
                <div key={i} className="border border-neutral-800 px-3 py-2 bg-neutral-950/50">
                  <div className="font-mono text-[11px] text-neutral-400">{(s.type ?? 'signal').replace(/_/g, ' ')}</div>
                  <div className="font-mono text-sm text-neutral-100 mt-0.5">{s.score ?? '—'}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button className="flex items-center gap-2 px-4 h-9 text-[12px] font-mono uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/15">
              <CircleCheck className="h-3.5 w-3.5" /> Log as Trade
            </button>
            <button className="flex items-center gap-2 px-4 h-9 text-[12px] font-mono uppercase tracking-wider text-neutral-400 border border-neutral-800 hover:border-neutral-700">
              <Eye className="h-3.5 w-3.5" /> Watchlist
            </button>
            <button className="flex items-center gap-2 px-4 h-9 text-[12px] font-mono uppercase tracking-wider text-neutral-400 border border-neutral-800 hover:border-neutral-700 ml-auto">
              <ExternalLink className="h-3.5 w-3.5" /> Open in TradeStation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ======================================================================
// REGIME VIEW
// ======================================================================

const RegimeView = ({ regime }) => {
  const vixSeries = Array.from({ length: 60 }, (_, i) => ({
    day: i,
    vix: 14 + Math.sin(i / 5) * 4 + Math.random() * 2,
  }));

  if (!regime || !regime.regime) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Regime data unavailable.
        </div>
      </div>
    );
  }

  const regimeLabel = (regime.regime ?? 'neutral').replace(/_/g, ' ');

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Macro Regime</div>
        <h1 className="font-serif text-3xl font-bold tracking-tight">
          <span className={regime.regime === 'risk_on' ? 'text-emerald-400' : regime.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'}>
            {regimeLabel}
          </span>
          <span className="text-neutral-500 italic font-light ml-3">({regime.conviction ?? 'unknown'} conviction)</span>
        </h1>
        <p className="text-neutral-400 mt-2 max-w-3xl">{regime.rationale}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="border border-neutral-800 p-5">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">VIX</div>
            <StatusDot status={regime.vol?.regime === 'extreme' ? 'danger' : regime.vol?.regime === 'elevated' ? 'warning' : 'healthy'} />
          </div>
          <div className="font-mono text-4xl font-semibold text-neutral-100 mt-2">{regime.vol?.level?.toFixed(1)}</div>
          <div className="mt-2 text-[11px] font-mono text-neutral-500 uppercase tracking-widest">
            {regime.vol?.regime} · {regime.vol?.trend} · p{regime.vol?.percentile}
          </div>
          <div className="h-16 mt-3">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={vixSeries}>
                <defs>
                  <linearGradient id="vixGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#14e89a" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#14e89a" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="vix" stroke="#14e89a" strokeWidth={1.5} fill="url(#vixGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="border border-neutral-800 p-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">10Y Yield</div>
          <div className="font-mono text-4xl font-semibold text-neutral-100 mt-2">{regime.rates?.tenYear?.toFixed(2)}<span className="text-neutral-500 text-xl">%</span></div>
          <div className="mt-2 text-[11px] font-mono text-neutral-500 uppercase tracking-widest">{regime.rates?.trend}</div>
          <div className="mt-4 pt-3 border-t border-neutral-800/80">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">2y10y Spread</span>
              <span className="font-mono text-sm text-neutral-200">{regime.rates?.twoTenSpread}bp</span>
            </div>
            <div className={`text-[10px] font-mono mt-1 uppercase tracking-wider ${
              regime.rates?.curveRegime === 'inverted' ? 'text-rose-400' : regime.rates?.curveRegime === 'steep' ? 'text-emerald-400' : 'text-neutral-500'
            }`}>
              {regime.rates?.curveRegime}
            </div>
          </div>
        </div>

        <div className="border border-neutral-800 p-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Risk Appetite</div>
          <div className="mt-3 space-y-3">
            <div>
              <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">SPY / TLT Trend</div>
              <div className={`text-sm mt-1 ${
                regime.riskAppetite?.ratioTrend === 'risk_on_rising' ? 'text-emerald-400' :
                regime.riskAppetite?.ratioTrend === 'risk_off_rising' ? 'text-rose-400' : 'text-neutral-300'
              }`}>
                {regime.riskAppetite?.ratioTrend?.replace(/_/g, ' ')}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">Credit Signal</div>
              <div className={`text-sm mt-1 ${
                regime.riskAppetite?.creditSignal === 'tightening_spreads' ? 'text-emerald-400' :
                regime.riskAppetite?.creditSignal === 'widening_spreads' ? 'text-rose-400' : 'text-neutral-300'
              }`}>
                {regime.riskAppetite?.creditSignal?.replace(/_/g, ' ')}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Multipliers panel */}
      <div className="border border-neutral-800 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Signal Multipliers</div>
            <h3 className="font-serif text-lg mt-1">How this regime adjusts each signal type</h3>
          </div>
          <Shield className="h-5 w-5 text-neutral-500" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label: 'Bullish Technical', value: regime.regime === 'risk_on' ? 1.15 : regime.regime === 'risk_off' ? 0.80 : 1.0 },
            { label: 'Bearish Technical', value: regime.regime === 'risk_on' ? 0.85 : regime.regime === 'risk_off' ? 1.20 : 1.0 },
            { label: 'Positive News', value: regime.regime === 'risk_on' ? 1.10 : regime.regime === 'risk_off' ? 0.85 : 1.0 },
            { label: 'Negative News', value: regime.regime === 'risk_on' ? 0.85 : regime.regime === 'risk_off' ? 1.15 : 1.0 },
            { label: 'Earnings Sell Premium', value: regime.vol?.regime === 'elevated' ? 1.15 : regime.vol?.regime === 'low' ? 0.90 : 1.0 },
            { label: 'Earnings Buy Premium', value: regime.vol?.regime === 'low' ? 1.15 : regime.vol?.regime === 'elevated' ? 0.85 : 1.0 },
          ].map(m => {
            const above = m.value > 1.0;
            const below = m.value < 1.0;
            return (
              <div key={m.label} className="flex items-center justify-between py-2 px-3 border border-neutral-800/60 bg-neutral-950/40">
                <span className="text-[12px] text-neutral-300">{m.label}</span>
                <span className={`font-mono text-sm ${above ? 'text-emerald-400' : below ? 'text-rose-400' : 'text-neutral-400'}`}>
                  ×{m.value.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ======================================================================
// ANALYSTS VIEW
// ======================================================================

const AnalystsView = ({ analysts }) => (
  <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
    <div className="mb-6">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Signal Producers</div>
      <h1 className="font-serif text-3xl font-bold tracking-tight">
        {analysts.length} <span className="text-neutral-500 italic font-light">analysts running</span>
      </h1>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {analysts.map(a => {
        const Icon = analystIcon[a.name] || Brain;
        return (
          <div key={a.name} className="border border-neutral-800 p-5 hover:border-neutral-700 transition-colors">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 border border-neutral-800 flex items-center justify-center bg-neutral-900/60">
                  <Icon className="h-4 w-4 text-neutral-400" />
                </div>
                <div>
                  <div className="font-serif text-lg">{a.label}</div>
                  <div className="font-mono text-[11px] text-neutral-500 uppercase tracking-wider mt-0.5">{a.name}</div>
                </div>
              </div>
              <StatusDot status={a.status} />
            </div>

            <div className="mt-4 grid grid-cols-3 gap-4 pt-4 border-t border-neutral-800/60">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">Signals 24h</div>
                <div className="font-mono text-lg text-neutral-100 mt-1">{a.signalsToday}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">Accuracy 7d</div>
                <div className={`font-mono text-lg mt-1 ${
                  !Number.isFinite(a.accuracy7d) ? 'text-neutral-600' :
                  a.accuracy7d >= 0.65 ? 'text-emerald-400' :
                  a.accuracy7d >= 0.55 ? 'text-sky-400' : 'text-amber-400'
                }`}>
                  {Number.isFinite(a.accuracy7d) ? `${(a.accuracy7d * 100).toFixed(0)}%` : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">Cost 24h</div>
                <div className="font-mono text-lg text-neutral-100 mt-1">{Number.isFinite(a.cost) ? `$${a.cost.toFixed(2)}` : '—'}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>

    <div className="mt-6 border border-neutral-800 p-5 bg-amber-500/5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-serif text-base text-neutral-200">Accuracy metrics are provisional</div>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            Accuracy is measured as: of signals that were tier-A or tier-B at time of firing, what fraction were in-the-money
            10 trading days later (≥2% for long signals, ≤-2% for short). Need 100+ closed observations per analyst before
            weights are tuned. Current sample is small — treat numbers as directional, not definitive.
          </p>
        </div>
      </div>
    </div>
  </div>
);

// ======================================================================
// ALERTS VIEW
// ======================================================================

const AlertsView = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [regimeAlert, setRegimeAlert] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [boardRes, catRes, earnRes, regRes] = await Promise.allSettled([
        fetch('/api/target-board?limit=50').then((r) => r.json()),
        fetch('/api/catalyst-board?index=sp500&filter=all&minConviction=low&limit=20').then((r) => r.json()),
        fetch('/api/earnings-board').then((r) => r.json()),
        fetch('/api/regime').then((r) => r.json()),
      ]);
      const firedAt = new Date().toISOString();
      const fired = [];

      // Board alerts: top 5 by composite + anything ≥80
      if (boardRes.status === 'fulfilled') {
        const targets = boardRes.value?.targets ?? [];
        const sorted = [...targets].sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));
        const keep = new Set([
          ...sorted.slice(0, 5).map((t) => t.ticker),
          ...targets.filter((t) => t.composite >= 80 || t.tier === 'A').map((t) => t.ticker),
        ]);
        for (const t of targets.filter((x) => keep.has(x.ticker))) {
          fired.push({
            id: `board-${t.ticker}`, source: 'Board', ticker: t.ticker,
            composite: t.composite, tier: t.tier, direction: t.direction,
            rationale: t.rationale || `${t.tier}-tier composite ${t.composite}`,
            firedAt,
          });
        }
      }

      // Catalyst alerts: high-conviction + anything composite ≥70
      if (catRes.status === 'fulfilled') {
        const picks = catRes.value?.picks ?? [];
        for (const p of picks.filter((x) => x.conviction === 'high' || x.composite >= 70).slice(0, 10)) {
          fired.push({
            id: `catalyst-${p.ticker}`, source: 'Catalyst', ticker: p.ticker,
            composite: p.composite, tier: p.conviction, direction: p.direction,
            rationale: p.rationale || 'catalyst convergence',
            firedAt,
          });
        }
      }

      // Earnings alerts: composite ≥80 within 10 days
      if (earnRes.status === 'fulfilled') {
        const setups = earnRes.value?.setups ?? [];
        for (const e of setups.filter((x) => x.composite >= 80 && x.daysUntil <= 10).slice(0, 10)) {
          fired.push({
            id: `earn-${e.ticker}`, source: 'Earnings', ticker: e.ticker,
            composite: e.composite, tier: e.strategy === 'Iron Condor' ? 'sell' : e.strategy === 'Long Straddle' ? 'buy' : '-',
            direction: null,
            rationale: e.rationale || `${e.strategy} · ${e.daysUntil}d to print`,
            firedAt,
          });
        }
      }

      // Regime "alert": not a row, a standalone status card
      if (regRes.status === 'fulfilled' && regRes.value?.regime) {
        setRegimeAlert({
          regime: regRes.value.regime,
          conviction: regRes.value.conviction,
          rationale: regRes.value.rationale,
          vix: regRes.value.vol?.level,
        });
      } else {
        setRegimeAlert(null);
      }

      // Dedupe by id, then sort by composite desc
      const byId = new Map();
      for (const f of fired) if (!byId.has(f.id)) byId.set(f.id, f);
      const deduped = Array.from(byId.values()).sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));
      setAlerts(deduped);
      setLastRefresh(firedAt);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const sourceColor = (s) => ({
    Board: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5',
    Catalyst: 'text-amber-400 border-amber-500/40 bg-amber-500/5',
    Earnings: 'text-sky-400 border-sky-500/40 bg-sky-500/5',
  }[s] || 'text-neutral-400 border-neutral-700 bg-neutral-900/40');

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Live Alert Feed</div>
          <h1 className="font-serif text-3xl font-bold tracking-tight">
            <span className="text-emerald-400">{alerts.length}</span>{' '}
            <span className="text-neutral-500 italic font-light">
              alert{alerts.length === 1 ? '' : 's'} firing
            </span>
          </h1>
          <p className="text-[11px] font-mono text-neutral-500 mt-2">
            Cross-surface scan: Board top picks, Catalyst convergences, near-term Earnings setups, Macro regime.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-[11px] font-mono border border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {regimeAlert && (
        <div className={`border p-4 mb-4 ${regimeAlert.regime === 'risk_on' ? 'border-emerald-500/30 bg-emerald-500/5' : regimeAlert.regime === 'risk_off' ? 'border-rose-500/30 bg-rose-500/5' : 'border-neutral-700 bg-neutral-900/40'}`}>
          <div className="flex items-baseline gap-3 mb-1">
            <Activity className="h-4 w-4 text-neutral-400" />
            <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">Macro Regime</span>
            <span className={`text-[13px] font-bold uppercase tracking-wider ${regimeAlert.regime === 'risk_on' ? 'text-emerald-400' : regimeAlert.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'}`}>
              {regimeAlert.regime.replace('_', ' ')}
            </span>
            <span className="text-[11px] text-neutral-500">({regimeAlert.conviction} conviction)</span>
            {regimeAlert.vix !== undefined && (
              <span className="text-[11px] font-mono text-neutral-500 ml-auto">VIX {regimeAlert.vix?.toFixed(1)}</span>
            )}
          </div>
          <div className="text-[11px] text-neutral-400 leading-relaxed">{regimeAlert.rationale}</div>
        </div>
      )}

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 font-mono text-[12px] mb-4">
          Alerts failed to load: {error}
        </div>
      )}

      {loading && !alerts.length && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Scanning Board + Catalyst + Earnings + Regime…
        </div>
      )}

      {!loading && !error && alerts.length === 0 && (
        <div className="border border-neutral-800 p-10 text-center">
          <div className="text-neutral-500 font-mono text-sm mb-2">No alerts firing right now.</div>
          <div className="text-neutral-600 text-[11px] font-mono">
            Nothing currently meets cross-surface alert thresholds.
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="border border-neutral-800 overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-950/60">
                {['Source', 'Ticker', 'Composite', 'Tier', 'Side', 'Rationale'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] font-mono text-neutral-500 uppercase tracking-widest">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {alerts.map(a => (
                <tr key={a.id} className="border-b border-neutral-800/60 hover:bg-neutral-900/40">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${sourceColor(a.source)}`}>
                      {a.source}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-serif font-bold text-lg">{a.ticker}</td>
                  <td className="px-4 py-3 font-mono text-emerald-400 font-semibold">{a.composite}</td>
                  <td className="px-4 py-3 text-[11px] font-mono text-neutral-400 uppercase tracking-wider">{a.tier ?? '-'}</td>
                  <td className="px-4 py-3">{a.direction ? <DirectionPill direction={a.direction} /> : <span className="text-neutral-600 text-xs">—</span>}</td>
                  <td className="px-4 py-3 text-[11px] text-neutral-400 max-w-md">
                    <div className="line-clamp-2">{a.rationale}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastRefresh && alerts.length > 0 && (
        <div className="text-[10px] font-mono text-neutral-600 mt-3 text-right">
          Last scan: {new Date(lastRefresh).toLocaleTimeString()} · {alerts.length} alerts across {new Set(alerts.map((a) => a.source)).size} sources
        </div>
      )}
    </div>
  );
};

// ======================================================================
// ENGINE TEST VIEW (live analyst execution)
// ======================================================================

const EngineTestView = () => {
  const [ticker, setTicker] = useState('NVDA');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const runTest = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch(`/api/engine-test?ticker=${encodeURIComponent(ticker.toUpperCase())}`);
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || `HTTP ${r.status}`);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Live Analyst Execution</div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
          Engine <span className="text-emerald-400 italic font-light">Test</span>
        </h1>
        <p className="text-neutral-400 text-sm mt-2">
          Runs the full analyst engine against a live ticker using real Polygon + Finnhub + FRED data.
          Takes 5-15 seconds. No Firestore required.
        </p>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <input
          type="text"
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && runTest()}
          placeholder="NVDA"
          className="w-32 h-10 bg-neutral-900 border border-neutral-800 px-3 font-mono text-neutral-100 focus:outline-none focus:border-emerald-500/50"
        />
        <button
          onClick={runTest}
          disabled={loading}
          className="h-10 px-5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono text-[12px] uppercase tracking-widest hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {loading ? 'Running…' : 'Run Engine'}
        </button>
      </div>

      {error && (
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-6">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-2">
            <CircleX className="h-4 w-4" /> Error
          </div>
          <pre className="text-[12px] text-neutral-300 whitespace-pre-wrap">{error}</pre>
        </div>
      )}

      {loading && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Loading bars for {ticker}, 11 sector ETFs, SPY, macro data…</div>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="border border-neutral-800 p-5">
            <div className="flex items-baseline gap-4 mb-3">
              <h2 className="font-serif font-bold text-2xl">{result.ticker}</h2>
              <span className="font-mono text-neutral-300">${result.price?.toFixed(2)}</span>
              <span className={`font-mono text-sm ${result.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {result.priceChangePct >= 0 ? '+' : ''}{result.priceChangePct?.toFixed(2)}%
              </span>
              <span className="ml-auto text-[11px] font-mono text-neutral-500">{result.durationMs}ms</span>
            </div>

            {result.target ? (
              <div className="border-l-2 pl-4 py-2" style={{ borderColor: tierColor(result.target.tier) }}>
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono text-3xl font-bold" style={{ color: tierColor(result.target.tier) }}>
                    {result.target.composite}
                  </span>
                  <ConvictionBadge tier={result.target.tier} />
                  <DirectionPill direction={result.target.direction} />
                </div>
                <p className="text-neutral-300 text-sm leading-relaxed">{result.target.rationale}</p>
              </div>
            ) : (
              <div className="text-neutral-500 text-sm italic">No composite signal — analysts returned nothing actionable for this ticker right now.</div>
            )}
          </div>

          {result.regime && (
            <div className="border border-neutral-800 p-5">
              <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Macro Regime</div>
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">Regime</div>
                  <div className={`font-serif text-lg ${
                    result.regime.regime === 'risk_on' ? 'text-emerald-400' :
                    result.regime.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'
                  }`}>{result.regime.regime?.replace('_', ' ')}</div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">VIX</div>
                  <div className="font-mono text-lg text-neutral-100">{result.regime.vol?.level?.toFixed(1)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">10Y</div>
                  <div className="font-mono text-lg text-neutral-100">{result.regime.rates?.tenYear?.toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">2Y10Y</div>
                  <div className="font-mono text-lg text-neutral-100">{result.regime.rates?.twoTenSpread}bp</div>
                </div>
              </div>
            </div>
          )}

          {result.sectorRanking && (
            <div className="border border-neutral-800 p-5">
              <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Sector Ranking (live vs SPY)</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {result.sectorRanking.map(s => (
                  <div key={s.etf} className="flex items-center justify-between text-[12px] font-mono border border-neutral-800/60 px-2 py-1">
                    <span className="text-neutral-500">#{s.rank}</span>
                    <span className="text-neutral-200">{s.etf}</span>
                    <span className={(s.composite ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {Number.isFinite(s.composite) ? `${s.composite >= 0 ? '+' : ''}${(s.composite * 100).toFixed(1)}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.entries(result.analysts || {}).map(([name, data]) => (
            <div key={name} className="border border-neutral-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">{name}-analyst</div>
                <div className="text-[11px] font-mono text-neutral-400">{data.signalCount} signal{data.signalCount !== 1 ? 's' : ''}</div>
              </div>
              {data.indicators && (
                <div className="grid grid-cols-3 md:grid-cols-5 gap-3 mb-3 text-[11px] font-mono">
                  {Object.entries(data.indicators).filter(([, v]) => v !== undefined).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-neutral-500 uppercase tracking-widest text-[9px]">{k}</div>
                      <div className="text-neutral-100">{v}</div>
                    </div>
                  ))}
                </div>
              )}
              {data.signals && data.signals.length > 0 && (
                <div className="space-y-2">
                  {data.signals.map((s, i) => (
                    <div key={i} className="border-l-2 border-neutral-700 pl-3 py-1">
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="font-mono text-neutral-200">{s.type}</span>
                        <span className="font-mono text-emerald-400">{s.score}</span>
                        <DirectionPill direction={s.direction} />
                      </div>
                      <div className="text-[11px] text-neutral-500 mt-0.5">{s.rationale}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="text-[10px] font-mono text-neutral-600 uppercase tracking-widest text-center py-3">
            Loaded {result.barsLoaded} bars · {result.totalSignals} total signals · {result.durationMs}ms
          </div>
        </div>
      )}
    </div>
  );
};

// ======================================================================
// EARNINGS PLAYS VIEW
// ======================================================================

// Small stat display used inside expanded earnings detail panels
const DetailStat = ({ label, value, color }) => (
  <div>
    <div className="text-neutral-500 uppercase tracking-widest text-[9px] font-mono mb-0.5">{label}</div>
    <div className="text-sm font-mono" style={color ? { color } : { color: '#e5e5e5' }}>{value}</div>
  </div>
);

const MOCK_EARNINGS = [
  {
    ticker: 'NVDA', reportDate: '2026-05-28', reportTime: 'AMC', daysUntil: 5,
    composite: 87, strategy: 'iron_condor', bias: 'sell_premium',
    ivr: 72, expectedMove: 5.8, priorMoves: [6.2, 7.1, 4.3, 5.9, 8.2],
    rationale: 'IVR elevated at 72 (market overpricing), prior 5 earnings moved avg 6.3% but stock historically follows 4.2% range post-event. Sell premium.',
  },
  {
    ticker: 'NFLX', reportDate: '2026-05-22', reportTime: 'AMC', daysUntil: -1,
    composite: 74, strategy: 'call_debit_spread', bias: 'buy_premium',
    ivr: 28, expectedMove: 9.1, priorMoves: [10.2, 12.5, 8.7, 11.1, 9.8],
    rationale: 'Low IVR (28) + bullish technicals + positive sentiment. Market underpricing move — buy premium.',
  },
  {
    ticker: 'TSLA', reportDate: '2026-05-28', reportTime: 'AMC', daysUntil: 5,
    composite: 68, strategy: 'long_straddle', bias: 'buy_premium',
    ivr: 45, expectedMove: 7.2, priorMoves: [8.5, 11.2, 6.8, 9.4, 12.1],
    rationale: 'Delivery miss risk. Prior moves avg 9.6% vs market expecting 7.2% — expected-move gap favors long gamma.',
  },
];

const EarningsPlaysView = () => {
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [expandedKey, setExpandedKey] = useState(null);
  const [loggedIds, setLoggedIds] = useState(() => new Set(readLog().filter((t) => t.source === 'earnings').map((t) => t.ticker + '|' + t.reportDate)));

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/earnings-board');
      const json = await r.json();
      if (!r.ok || json.error) {
        setError(json.error || `HTTP ${r.status}`);
      } else {
        setData(validate(json, SHAPES.earningsBoard, "earnings-board"));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const setups = data?.setups || [];
  const filtered = setups
    .filter(e => filter === 'all' || e.bias === filter)
    .sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Earnings Setups</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {loading ? (
              <span className="text-neutral-500 italic font-light">loading…</span>
            ) : (
              <>
                <span className="text-emerald-400">{filtered.length}</span> <span className="text-neutral-500 italic font-light">earnings plays within 14 days</span>
              </>
            )}
          </h1>
          <p className="text-neutral-400 text-sm mt-2 max-w-2xl">
            Live scoring across IVR proxy, expected move, prior reactions, and timing.
            Pulls Finnhub calendar → enriches with Polygon bars → scores each setup.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="h-8 px-3 border border-neutral-800 text-[11px] font-mono uppercase tracking-widest text-neutral-400 hover:text-neutral-200 disabled:opacity-50 flex-shrink-0">
          {loading ? '…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-4">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-1">
            <CircleX className="h-4 w-4" /> Error
          </div>
          <div className="text-[12px] text-neutral-300">{error}</div>
        </div>
      )}

      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Loading earnings calendar and computing IV proxies…</div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">This takes 10-20 seconds (pulls ~25 tickers of bars)</div>
        </div>
      )}

      {data && (
        <div className="flex items-center gap-1 text-[11px] font-mono mb-5">
          <span className="text-neutral-500 mr-2 uppercase tracking-widest">Bias</span>
          {[
            ['all', 'ALL'],
            ['sell_premium', 'SELL'],
            ['buy_premium', 'BUY'],
          ].map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`px-2 h-7 ${filter === key ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'}`}>
              {label}
            </button>
          ))}
          <span className="ml-auto text-neutral-600 text-[10px]">
            Checked {data.universeChecked} · Generated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        </div>
      )}

      {filtered.length === 0 && data && !loading && (
        <div className="border border-neutral-800 p-6 text-center text-neutral-500 text-sm">
          No qualifying earnings plays right now. {data.universeChecked} tickers have earnings in the next 14 days but none hit the scoring threshold.
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(e => {
          const strategyLabel = {
            iron_condor: 'Iron Condor',
            short_strangle: 'Short Strangle',
            long_straddle: 'Long Straddle',
            call_debit_spread: 'Call Debit Spread',
            put_debit_spread: 'Put Debit Spread',
          }[e.strategy] || e.strategy;
          const biasColor = e.bias === 'sell_premium' ? '#4dbaf2' : '#14e89a';
          const biasLabel = (e.bias ?? 'unknown').replace(/_/g, ' ');
          const cardKey = `${e.ticker ?? '?'}|${e.reportDate ?? '?'}`;
          const isOpen = expandedKey === cardKey;
          const alreadyLogged = loggedIds.has(cardKey);
          const moveRatio = (Number.isFinite(e.avgPriorMove) && Number.isFinite(e.expectedMove) && e.expectedMove > 0)
            ? e.avgPriorMove / e.expectedMove : null;
          const handleLog = (ev) => {
            ev.stopPropagation();
            if (alreadyLogged) return;
            logTrade({
              ticker: e.ticker,
              source: 'earnings',
              loggedPrice: e.price,
              strategy: strategyLabel,
              bias: e.bias,
              reportDate: e.reportDate,
              reportTime: e.reportTime,
              daysUntilAtLog: e.daysUntil,
              expectedMove: e.expectedMove,
              ivr: e.ivr,
              avgPriorMove: e.avgPriorMove,
              composite: e.composite,
              rationale: e.rationale,
            });
            setLoggedIds(new Set([...loggedIds, cardKey]));
          };
          return (
            <div
              key={cardKey}
              onClick={() => setExpandedKey(isOpen ? null : cardKey)}
              className={`border bg-neutral-950/40 p-4 sm:p-5 cursor-pointer transition-colors ${isOpen ? 'border-neutral-600' : 'border-neutral-800 hover:border-neutral-700'}`}
            >
              <div className="flex items-start justify-between mb-3 gap-3">
                <div>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="font-serif font-bold text-xl">{e.ticker}</span>
                    {e.price && <span className="text-[12px] font-mono text-neutral-400">${e.price.toFixed(2)}</span>}
                    <span className="text-[11px] font-mono text-neutral-400">
                      {e.reportDate} · {e.reportTime}
                    </span>
                    <span className={`text-[11px] font-mono ${e.daysUntil < 0 ? 'text-neutral-500' : e.daysUntil <= 3 ? 'text-amber-400' : 'text-neutral-400'}`}>
                      {e.daysUntil < 0 ? `reported ${Math.abs(e.daysUntil)}d ago` : `in ${e.daysUntil}d`}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest border"
                      style={{ color: biasColor, borderColor: biasColor + '55', background: biasColor + '15' }}>
                      {biasLabel}
                    </span>
                    <span className="text-[12px] text-neutral-300">{strategyLabel}</span>
                    {alreadyLogged && (
                      <span className="text-[10px] font-mono text-emerald-400 border border-emerald-500/40 px-1.5 py-0.5">
                        LOGGED
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono tabular-nums text-2xl font-bold" style={{ color: e.composite >= 80 ? '#14e89a' : '#4dbaf2' }}>
                    {e.composite}
                  </div>
                  <div className="text-[9px] text-neutral-500 uppercase tracking-widest">score</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-3 text-[11px] font-mono">
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">IV Proxy</div>
                  <div className={`text-sm ${e.ivr >= 60 ? 'text-emerald-400' : e.ivr <= 30 ? 'text-amber-400' : 'text-neutral-300'}`}>
                    {e.ivr}
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">Expected Move</div>
                  <div className="text-neutral-200 text-sm">±{e.expectedMove?.toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">Avg Prior Move</div>
                  <div className="text-neutral-200 text-sm">
                    {Number.isFinite(e.avgPriorMove) ? e.avgPriorMove.toFixed(1) + '%' : '—'}
                  </div>
                </div>
              </div>

              <p className="text-[12px] text-neutral-400 leading-relaxed">{e.rationale}</p>

              {isOpen && (
                <div className="mt-4 pt-4 border-t border-neutral-800 space-y-3" onClick={(ev) => ev.stopPropagation()}>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
                    <DetailStat label="Report Time" value={e.reportTime?.toUpperCase() || '—'} />
                    <DetailStat label="Days Until" value={`${e.daysUntil}d`} />
                    <DetailStat
                      label="Prior / Expected"
                      value={moveRatio !== null ? `${moveRatio.toFixed(2)}x` : '—'}
                      color={moveRatio === null ? undefined : (
                        (e.bias === 'sell_premium' && moveRatio < 0.8) ||
                        (e.bias === 'buy_premium' && moveRatio > 1.2)
                      ) ? '#14e89a' : '#f59e0b'}
                    />
                    <DetailStat label="Score" value={e.composite} color={e.composite >= 80 ? '#14e89a' : '#4dbaf2'} />
                  </div>

                  <div className="text-[11px] text-neutral-400 leading-relaxed bg-neutral-900/40 border border-neutral-800 p-3">
                    <div className="font-mono uppercase tracking-widest text-[9px] text-neutral-500 mb-1">Strategy read</div>
                    {e.bias === 'sell_premium'
                      ? `Iron Condor profits if ${e.ticker} stays within ±${e.expectedMove?.toFixed(1)}% of current price through ${e.reportDate}. Prior average move (${Number.isFinite(e.avgPriorMove) ? e.avgPriorMove.toFixed(1) + '%' : 'unknown'}) ${moveRatio !== null && moveRatio < 0.8 ? 'suggests overpriced IV — good setup' : moveRatio !== null && moveRatio > 1.2 ? 'suggests IV might be underpriced — caution' : 'is mixed'}. Size small — a single bad print eats several winners.`
                      : `Long Straddle profits if ${e.ticker} moves MORE than ±${e.expectedMove?.toFixed(1)}% through ${e.reportDate}. Prior average move (${Number.isFinite(e.avgPriorMove) ? e.avgPriorMove.toFixed(1) + '%' : 'unknown'}) ${moveRatio !== null && moveRatio > 1.2 ? 'suggests realized moves typically exceed expected — edge intact' : moveRatio !== null && moveRatio < 0.8 ? 'suggests underwhelming prior reactions — risk of theta decay' : 'is mixed'}. Time the exit for day-of-print or day-after.`
                    }
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={handleLog}
                      disabled={alreadyLogged}
                      className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-widest border transition-colors ${
                        alreadyLogged
                          ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10 cursor-default'
                          : 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/15'
                      }`}
                    >
                      {alreadyLogged ? '✓ Logged' : '+ Log Trade'}
                    </button>
                    <span className="text-[10px] text-neutral-600 font-mono">
                      {alreadyLogged ? 'See Journal tab for forward returns' : 'Tracks 5d/20d/30d/60d/90d returns in Journal'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 border border-amber-500/20 bg-amber-500/5 p-4 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-serif text-base text-neutral-200">IV crush risk on every earnings trade</div>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            IV values are a realized-vol proxy until TradeStation options chain is wired up.
            Real IV Rank will be more precise. Even a correct directional call can lose if the
            realized move matches the expected move. Size tiny until you have 20+ closed earnings trades.
          </p>
        </div>
      </div>
    </div>
  );
};

// ======================================================================
// OPTIONS PLAYS VIEW
// ======================================================================

const MOCK_OPTIONS_PLAYS = [
  {
    ticker: 'NVDA', strategyType: 'unusual_call_activity', score: 95,
    strike: 220, expiration: '2026-05-15', type: 'call',
    volume: 4500, openInterest: 1200, vOiRatio: 3.75, premium: 1887000,
    delta: 0.35, iv: 48.2, underlyingPrice: 201.63,
    otmPct: 9.1, daysToExpiry: 24,
    rationale: 'Massive call sweep at 220 strike — 3.75x OI, $1.9M premium. Directional bet on 10%+ move within 24 days.',
  },
  {
    ticker: 'AMD', strategyType: 'unusual_put_activity', score: 82,
    strike: 130, expiration: '2026-05-15', type: 'put',
    volume: 3200, openInterest: 850, vOiRatio: 3.76, premium: 720000,
    delta: -0.32, iv: 52.1, underlyingPrice: 142.50,
    otmPct: 8.8, daysToExpiry: 24,
    rationale: 'Put flow at 130 strike before NVDA earnings — likely hedge or bearish bet on semi pullback.',
  },
  {
    ticker: 'SPY', strategyType: 'unusual_call_activity', score: 68,
    strike: 720, expiration: '2026-04-30', type: 'call',
    volume: 12000, openInterest: 8500, vOiRatio: 1.41, premium: 1500000,
    delta: 0.22, iv: 14.1, underlyingPrice: 708.72,
    otmPct: 1.6, daysToExpiry: 9,
    rationale: 'Short-dated SPY calls, 1.6% OTM. Tactical bet on risk-on continuation through month-end.',
  },
];

const OptionsPlaysView = () => {
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/options-flow');
      const json = await r.json();
      if (!r.ok || json.error) {
        setError(json.error || `HTTP ${r.status}`);
      } else {
        setData(validate(json, SHAPES.optionsFlow, "options-flow"));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const candidates = data?.candidates || [];
  const filtered = candidates
    .filter(o => filter === 'all'
      || (filter === 'bullish' && o.direction === 'bullish')
      || (filter === 'bearish' && o.direction === 'bearish'))
    .sort((a, b) => b.score - a.score);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Unusual Activity</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {loading ? (
              <span className="text-neutral-500 italic font-light">loading…</span>
            ) : (
              <>
                <span className="text-emerald-400">{filtered.length}</span> <span className="text-neutral-500 italic font-light">tickers flagged</span>
              </>
            )}
          </h1>
          <p className="text-neutral-400 text-sm mt-2 max-w-2xl">
            Volume surges, price breakouts, and realized-vol spikes that typically precede
            unusual options flow. True options chain data requires TradeStation (pending).
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="h-8 px-3 border border-neutral-800 text-[11px] font-mono uppercase tracking-widest text-neutral-400 hover:text-neutral-200 disabled:opacity-50 flex-shrink-0">
          {loading ? '…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-4">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-1">
            <CircleX className="h-4 w-4" /> Error
          </div>
          <div className="text-[12px] text-neutral-300">{error}</div>
        </div>
      )}

      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Scanning watchlist for volume surges and vol-regime changes…</div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">10-15 seconds</div>
        </div>
      )}

      {data?.proxyNote && (
        <div className="border border-amber-500/20 bg-amber-500/5 px-3 py-2 mb-4 flex items-start gap-2">
          <Info className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-[11px] text-neutral-400 leading-relaxed">
            <span className="text-amber-400 font-mono uppercase tracking-widest mr-2">Proxy mode</span>
            {data.proxyNote}
          </div>
        </div>
      )}

      {data && (
        <div className="flex items-center gap-1 text-[11px] font-mono mb-5">
          <span className="text-neutral-500 mr-2 uppercase tracking-widest">Bias</span>
          {[
            ['all', 'ALL'],
            ['bullish', 'BULLISH'],
            ['bearish', 'BEARISH'],
          ].map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`px-2 h-7 ${filter === key ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'}`}>
              {label}
            </button>
          ))}
          <span className="ml-auto text-neutral-600 text-[10px]">
            {data.universeChecked} checked · {(() => { const d = data.generatedAt ? new Date(data.generatedAt) : null; return d && !isNaN(d.getTime()) ? d.toLocaleTimeString() : '—'; })()}
          </span>
        </div>
      )}

      {filtered.length === 0 && data && !loading && (
        <div className="border border-neutral-800 p-6 text-center text-neutral-500 text-sm">
          No qualifying flow candidates right now. Watchlist scanned but nothing scored high enough — could be a quiet tape.
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((o) => {
          const color = o.direction === 'bullish' ? '#14e89a'
            : o.direction === 'bearish' ? '#ff5577'
            : '#b0b4c0';
          return (
            <div key={o.ticker} className="border border-neutral-800 hover:border-neutral-700 p-4 sm:p-5">
              <div className="flex items-start justify-between mb-3 gap-3">
                <div>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="font-serif font-bold text-xl">{o.ticker}</span>
                    <span className="text-[12px] font-mono text-neutral-400">${o.underlyingPrice?.toFixed(2)}</span>
                    <span className={`text-[12px] font-mono ${o.intradayChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {o.intradayChangePct >= 0 ? '+' : ''}{o.intradayChangePct?.toFixed(2)}%
                    </span>
                  </div>
                  <div className="mt-2">
                    <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest border"
                      style={{ color, borderColor: color + '55', background: color + '15' }}>
                      {o.direction} flow likely
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono tabular-nums text-2xl font-bold" style={{ color }}>
                    {o.score}
                  </div>
                  <div className="text-[9px] text-neutral-500 uppercase tracking-widest">score</div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 text-[11px] font-mono">
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">Volume Ratio</div>
                  <div className={`text-sm ${o.volumeRatio >= 3 ? 'text-emerald-400' : o.volumeRatio >= 2 ? 'text-neutral-100' : 'text-neutral-300'}`}>
                    {o.volumeRatio?.toFixed(2)}x
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">Vol Regime</div>
                  <div className={`text-sm ${o.volRegime >= 1.5 ? 'text-amber-400' : 'text-neutral-200'}`}>
                    {o.volRegime?.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">vs MA20</div>
                  <div className={`text-sm ${o.distFromMa20Pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {o.distFromMa20Pct >= 0 ? '+' : ''}{o.distFromMa20Pct?.toFixed(1)}%
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">ATM Strike</div>
                  <div className="text-neutral-200 text-sm">${o.approxAtmStrike}</div>
                </div>
              </div>

              <p className="text-[12px] text-neutral-400 leading-relaxed">{o.rationale}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-6 border border-amber-500/20 bg-amber-500/5 p-4 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-serif text-base text-neutral-200">Underlying-based proxy, not true chain flow</div>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            These signals often precede unusual options activity but don't confirm strike-level positioning.
            The direction is inferred from price action, not option buyer intent. When TradeStation OAuth is wired
            up, this will upgrade to true strike/volume/premium analysis.
          </p>
        </div>
      </div>
    </div>
  );
};

// ======================================================================
// SETTINGS VIEW (condensed)
// ======================================================================

const SettingsView = () => (
  <div className="px-3 py-4 sm:p-6 max-w-[1200px] mx-auto space-y-4">
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Configuration</div>
      <h1 className="font-serif text-3xl font-bold tracking-tight">Settings</h1>
    </div>

    <div className="border border-neutral-800 p-5">
      <h3 className="font-serif text-lg mb-4">Data Sources</h3>
      <div className="space-y-3">
        {[
          { name: 'Polygon.io Stocks Advanced', purpose: 'Bulk scanning, prices, fundamentals, news', status: 'pending' },
          { name: 'TradeStation API', purpose: 'Real-time quotes, options chains, execution', status: 'pending' },
          { name: 'Finnhub Premium', purpose: 'Earnings, revisions, insider transactions', status: 'pending' },
          { name: 'FRED', purpose: 'Macro rates data (free)', status: 'pending' },
          { name: 'Claude API', purpose: 'News sentiment, geopolitical synthesis, narratives', status: 'pending' },
        ].map(s => (
          <div key={s.name} className="flex items-center justify-between py-2">
            <div className="flex items-center gap-3">
              <StatusDot status={s.status === 'connected' ? 'healthy' : 'warning'} />
              <div>
                <div className="text-neutral-200">{s.name}</div>
                <div className="text-[11px] text-neutral-500 font-mono">{s.purpose}</div>
              </div>
            </div>
            <span className={`font-mono text-[10px] uppercase tracking-widest px-2 py-1 border ${
              s.status === 'connected' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' :
              'text-amber-400 border-amber-500/30 bg-amber-500/10'
            }`}>
              {s.status === 'connected' ? 'CONNECTED' : 'ADD KEY'}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-neutral-500 font-mono mt-4">
        Keys managed via Netlify env vars. Never exposed to the browser.
      </p>
    </div>

    <div className="border border-neutral-800 p-5 bg-rose-500/5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-rose-400 flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="font-serif text-base text-neutral-200">Not Financial Advice</h3>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            TradeIQ Alpha synthesizes signals from multiple data sources into ranked trade ideas. It is a research
            tool, not investment advice. Past signal accuracy does not predict future results. Size positions appropriately,
            track outcomes, and remember: a coherent-sounding AI narrative can make a noise setup look like signal.
            Let outcome data, not thesis elegance, determine whether you follow a target.
          </p>
        </div>
      </div>
    </div>
  </div>
);

// ======================================================================
// BACKTEST VIEW
// ======================================================================

const BacktestView = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [lookback, setLookback] = useState(365);
  const [window, setWindow] = useState(20); // 5, 10, or 20 day forward window

  const load = async (days = lookback) => {
    setLoading(true); setError(null);
    try {
      const tickers = 'NVDA,AAPL,MSFT,GOOGL,AMZN,META,TSLA,AVGO,AMD,INTC';
      const r = await fetch(`/api/backtest?lookbackDays=${days}&tickers=${tickers}&sampleEvery=5`);
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setData(validate(json, SHAPES.backtest, "backtest"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !data) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Running backtest across 10 tickers, 18 months of history…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-rose-800/50 bg-rose-950/20 p-6 text-rose-300 font-mono text-sm">
          Backtest failed: {error}
          <button onClick={() => load()} className="ml-4 underline">retry</button>
        </div>
      </div>
    );
  }

  // Shape safety — even if server returns partial data, each piece defaults to empty
  if (!data || !data.summary) {
    return (
      <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Backtest data unavailable.
          <button onClick={() => load()} className="ml-4 underline">retry</button>
        </div>
      </div>
    );
  }

  const summary = data.summary;
  const windowKey = `fwd${window}`;
  const overall = summary[windowKey] || {};

  // Chart data: tier win rate + avg return
  const byTier = data.byTier || {};
  const byDirection = data.byDirection || {};
  const tierChartData = ['A', 'B', 'C'].map(tier => {
    const s = byTier[tier]?.[windowKey] || {};
    return {
      tier: `Tier ${tier}`,
      winRate: ((s.winRate || 0) * 100),
      avgReturn: ((s.avgReturn || 0) * 100),
      alpha: ((s.avgAlphaVsSPY || 0) * 100),
      n: byTier[tier]?.n || 0,
    };
  });

  // Direction comparison
  const dirChartData = ['long', 'short'].map(dir => {
    const s = byDirection[dir]?.[windowKey] || {};
    return {
      direction: dir === 'long' ? 'Long' : 'Short',
      winRate: ((s.winRate || 0) * 100),
      avgReturn: ((s.avgReturn || 0) * 100),
      alpha: ((s.avgAlphaVsSPY || 0) * 100),
      n: data.byDirection[dir]?.n || 0,
    };
  });

  // Equity curve: cumulative alpha over sorted trades
  const tradesSample = data.trades?.sample || data.trades || [];
  const sortedTrades = tradesSample
    .filter(t => typeof t[windowKey] === 'number')
    .slice()
    .sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));

  let cumLong = 0, cumShort = 0, cumAll = 0;
  const equityData = sortedTrades.map((t, i) => {
    const alpha = (t[`${windowKey}_alpha`] || 0) * 100;
    cumAll += alpha;
    if (t.direction === 'long') cumLong += alpha;
    else if (t.direction === 'short') cumShort += alpha;
    return {
      idx: i,
      date: t.entryDate,
      cumAlpha: +cumAll.toFixed(2),
      cumLong: +cumLong.toFixed(2),
      cumShort: +cumShort.toFixed(2),
    };
  });

  // Return distribution histogram (bucketed)
  const rets = tradesSample.map(t => (t[windowKey] || 0) * 100).filter(v => !isNaN(v));
  const buckets = [-20, -10, -5, -2, 0, 2, 5, 10, 20];
  const distData = [];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    const label = i === 0 ? `<${hi}%` : i === buckets.length - 2 ? `>${lo}%` : `${lo} to ${hi}`;
    const count = rets.filter(r => r >= lo && r < hi).length;
    distData.push({ bucket: label, count, positive: lo >= 0 });
  }

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Backtest</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {summary.n ?? 0} <span className="text-neutral-500 italic font-light">historical trades</span>
          </h1>
          <div className="text-[11px] font-mono text-neutral-500 mt-2">
            {data.config?.from ?? '—'} → {data.config?.to ?? '—'} · 10 mega-caps · sampled every {data.config?.sampleEvery ?? '—'}d
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
          <span className="text-neutral-500 uppercase tracking-widest">Window</span>
          {[5, 10, 20].map(w => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-2 h-7 ${window === w ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {/* Overall KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <KpiCard label="Win Rate" value={`${((overall.winRate || 0) * 100).toFixed(1)}%`} color={overall.winRate > 0.5 ? 'emerald' : 'rose'} />
        <KpiCard label="Avg Return" value={`${((overall.avgReturn || 0) * 100).toFixed(2)}%`} color={overall.avgReturn > 0 ? 'emerald' : 'rose'} />
        <KpiCard label={`Alpha vs SPY`} value={`${((overall.avgAlphaVsSPY || 0) * 100).toFixed(2)}%`} color={overall.avgAlphaVsSPY > 0 ? 'emerald' : 'rose'} />
        <KpiCard label="Sharpe" value={(overall.sharpe || 0).toFixed(2)} color={overall.sharpe > 0 ? 'emerald' : 'rose'} />
      </div>

      {/* Chart 1 + 2: tier + direction win rates (side-by-side on desktop) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <ChartPanel title="Performance by Tier" subtitle={`${window}-day forward`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={tierChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="tier" stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} />
              <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} tickFormatter={v => `${v}%`} />
              <Tooltip contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }} />
              <Bar dataKey="winRate" fill="#14e89a" name="Win Rate %" />
              <Bar dataKey="alpha" fill="#4dbaf2" name="Alpha vs SPY %" />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>

        <ChartPanel title="Long vs Short" subtitle={`${window}-day forward`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={dirChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="direction" stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} />
              <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} tickFormatter={v => `${v}%`} />
              <Tooltip contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }} />
              <Bar dataKey="winRate" fill="#14e89a" name="Win Rate %" />
              <Bar dataKey="alpha" fill="#4dbaf2" name="Alpha vs SPY %" />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
      </div>

      {/* Chart 3: cumulative alpha equity curve */}
      <ChartPanel title="Cumulative Alpha vs SPY" subtitle={`${window}-day forward returns, by direction`} className="mb-4">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={equityData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" />
            <XAxis dataKey="idx" stroke="#6b7280" style={{ fontSize: 10, fontFamily: 'monospace' }} tick={false} label={{ value: 'Trade #', position: 'insideBottom', offset: -2, style: { fill: '#6b7280', fontSize: 10 } }} />
            <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} tickFormatter={v => `${v}%`} />
            <Tooltip
              contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }}
              labelFormatter={(i) => equityData[i]?.date || ''}
            />
            <Line type="monotone" dataKey="cumAlpha" stroke="#f3f4f6" strokeWidth={2} dot={false} name="All trades" />
            <Line type="monotone" dataKey="cumLong" stroke="#14e89a" strokeWidth={1.5} dot={false} name="Longs only" />
            <Line type="monotone" dataKey="cumShort" stroke="#ff5577" strokeWidth={1.5} dot={false} name="Shorts only" />
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>

      {/* Chart 4: return distribution */}
      <ChartPanel title="Return Distribution" subtitle={`${window}-day forward returns, all trades`} className="mb-4">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={distData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1f2023" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="bucket" stroke="#6b7280" style={{ fontSize: 10, fontFamily: 'monospace' }} />
            <YAxis stroke="#6b7280" style={{ fontSize: 11, fontFamily: 'monospace' }} />
            <Tooltip contentStyle={{ background: '#0a0b0d', border: '1px solid #2a2b2e', fontSize: 12 }} />
            <Bar dataKey="count" name="Trades">
              {distData.map((d, i) => (
                <Cell key={i} fill={d.positive ? '#14e89a' : '#ff5577'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      {/* Key findings callout */}
      <div className="border border-neutral-800 bg-neutral-950/40 p-4 sm:p-5 mb-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Findings</div>
        <ul className="space-y-2 text-sm text-neutral-300">
          {data.byDirection?.short?.[windowKey]?.avgAlphaVsSPY < -0.01 && (
            <li className="flex gap-2">
              <span className="text-rose-400">▾</span>
              <span>Shorts underperform by <span className="text-rose-400 font-semibold">{((data.byDirection.short[windowKey].avgAlphaVsSPY) * 100).toFixed(1)}%</span> alpha — disabled in production by default.</span>
            </li>
          )}
          {data.byTier?.A?.[windowKey]?.avgAlphaVsSPY > 0.005 && (
            <li className="flex gap-2">
              <span className="text-emerald-400">▴</span>
              <span>Tier A generates <span className="text-emerald-400 font-semibold">+{((data.byTier.A[windowKey].avgAlphaVsSPY) * 100).toFixed(1)}%</span> alpha at {(data.byTier.A[windowKey].winRate * 100).toFixed(0)}% win rate.</span>
            </li>
          )}
          {data.byTier?.C?.[windowKey]?.winRate < 0.5 && (
            <li className="flex gap-2">
              <span className="text-neutral-500">•</span>
              <span>Tier C is below 50% win rate — current score floor (60) is effective.</span>
            </li>
          )}
        </ul>
      </div>

      {/* Trade log (condensed) */}
      <ChartPanel title={`Recent Trades (${Math.min(20, sortedTrades.length)} of ${summary.n})`} subtitle="Sorted by entry date">
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-[11px] font-mono">
            <thead className="text-neutral-500 border-b border-neutral-800">
              <tr>
                <th className="text-left px-2 py-2">Date</th>
                <th className="text-left px-2 py-2">Ticker</th>
                <th className="text-left px-2 py-2">Tier</th>
                <th className="text-left px-2 py-2">Dir</th>
                <th className="text-right px-2 py-2">Score</th>
                <th className="text-right px-2 py-2">{window}d Ret</th>
                <th className="text-right px-2 py-2">{window}d α</th>
              </tr>
            </thead>
            <tbody>
              {sortedTrades.slice(-20).reverse().map((t, i) => (
                <tr key={i} className="border-b border-neutral-900 hover:bg-neutral-900/30">
                  <td className="px-2 py-1.5 text-neutral-400">{t.entryDate}</td>
                  <td className="px-2 py-1.5 text-neutral-100 font-semibold">{t.ticker}</td>
                  <td className="px-2 py-1.5" style={{ color: tierColor(t.tier) }}>{t.tier}</td>
                  <td className={`px-2 py-1.5 ${t.direction === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.direction}</td>
                  <td className="px-2 py-1.5 text-right text-neutral-300">{t.composite}</td>
                  <td className={`px-2 py-1.5 text-right ${(t[windowKey] || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {((t[windowKey] || 0) * 100).toFixed(2)}%
                  </td>
                  <td className={`px-2 py-1.5 text-right ${(t[`${windowKey}_alpha`] || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {((t[`${windowKey}_alpha`] || 0) * 100).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartPanel>

      <div className="text-[10px] text-neutral-600 font-mono mt-4 text-center">
        Technical + sector-rotation analysts only · news/fundamental/flow not backtested (historical data gaps)
      </div>
    </div>
  );
};

const KpiCard = ({ label, value, color = 'neutral' }) => {
  const colorClass = color === 'emerald' ? 'text-emerald-400' : color === 'rose' ? 'text-rose-400' : 'text-neutral-200';
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4">
      <div className="text-[9px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-1.5">{label}</div>
      <div className={`text-xl sm:text-2xl font-mono font-semibold tabular-nums ${colorClass}`}>{value}</div>
    </div>
  );
};

const ChartPanel = ({ title, subtitle, children, className = '' }) => (
  <div className={`border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4 ${className}`}>
    <div className="flex items-baseline justify-between mb-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">{title}</div>
        {subtitle && <div className="text-[10px] text-neutral-600 font-mono mt-0.5">{subtitle}</div>}
      </div>
    </div>
    {children}
  </div>
);

// ======================================================================
// RESEARCH PANEL (used inside TargetDetail modal)
// ======================================================================

const ResearchPanel = ({ ticker }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [brief, setBrief] = useState(null);
  const [requested, setRequested] = useState(false);

  const load = async (force = false) => {
    setLoading(true); setError(null); setRequested(true);
    try {
      const r = await fetch(`/api/research?ticker=${ticker}${force ? '&force=1' : ''}`);
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setBrief(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!requested) {
    return (
      <div className="border border-dashed border-neutral-800 p-5 text-center">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">AI Research Brief</div>
        <button
          onClick={() => load()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-colors text-[12px] font-medium"
        >
          <Brain className="h-4 w-4" />
          Generate brief with Claude
        </button>
        <div className="text-[10px] text-neutral-600 font-mono mt-3">
          Reads last 7 days of news + current price + board context · ~3s
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border border-neutral-800 p-5 text-center text-neutral-500 font-mono text-sm">
        Claude is reading the news on {ticker}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 text-sm">
        Research failed: {error}
        <button onClick={() => load()} className="ml-3 underline text-xs">retry</button>
      </div>
    );
  }

  const b = brief?.brief || {};
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">AI Research Brief</div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-neutral-600">
          {brief?.cached && <span>cached {Math.round(brief.cacheAgeMs / 60000)}m ago</span>}
          <button onClick={() => load(true)} className="text-neutral-400 hover:text-neutral-200 underline">refresh</button>
        </div>
      </div>

      {b.summary && (
        <div className="border-l-2 border-emerald-500/40 pl-3">
          <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1">Net Thesis</div>
          <p className="text-neutral-100 text-sm leading-relaxed">{b.summary}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {b.bull_case && (
          <div className="border border-emerald-800/30 bg-emerald-950/10 p-3">
            <div className="text-[9px] uppercase tracking-widest text-emerald-500 mb-1.5">Bull Case</div>
            <p className="text-sm text-neutral-200 leading-relaxed">{b.bull_case}</p>
          </div>
        )}
        {b.bear_case && (
          <div className="border border-rose-800/30 bg-rose-950/10 p-3">
            <div className="text-[9px] uppercase tracking-widest text-rose-500 mb-1.5">Bear Case</div>
            <p className="text-sm text-neutral-200 leading-relaxed">{b.bear_case}</p>
          </div>
        )}
      </div>

      {b.key_catalyst && (
        <div className="border border-neutral-800 p-3">
          <div className="text-[9px] uppercase tracking-widest text-amber-500 mb-1.5">Key Catalyst</div>
          <p className="text-sm text-neutral-200">{b.key_catalyst}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-[10px] font-mono">
        {b.confidence && <span className="text-neutral-500">Confidence: <span className="text-neutral-300 uppercase">{b.confidence}</span></span>}
        {b.time_horizon && <span className="text-neutral-500">Horizon: <span className="text-neutral-300">{b.time_horizon}</span></span>}
        {brief?.newsCount != null && <span className="text-neutral-500">News: <span className="text-neutral-300">{brief.newsCount} articles</span></span>}
      </div>

      {b.citations?.length > 0 && (
        <details className="text-[11px] text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">Citations ({b.citations.length})</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {b.citations.map((c, i) => (
              <li key={i} className="text-neutral-400 leading-relaxed">· {c}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

// ======================================================================
// MAIN APP
// ======================================================================

export default function App() {
  const [activeView, setActiveView] = useState('board');
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [universe, setUniverse] = useState('sp500');
  const [regime, setRegime] = useState(MOCK_REGIME);
  const [analysts, setAnalysts] = useState(MOCK_ANALYSTS);
  const showUniverseBar = UNIVERSE_AWARE_VIEWS.has(activeView);

  useEffect(() => {
    // Live regime from FRED. Falls back to MOCK_REGIME if network/auth fails.
    fetch('/api/regime')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.regime) setRegime(d); })
      .catch(() => {});
    // Live analyst roster + health. Falls back to MOCK_ANALYSTS.
    fetch('/api/analysts-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.analysts?.length) setAnalysts(d.analysts); })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-[#050607] text-neutral-200 overflow-x-hidden" style={{
      fontFamily: '"Sora", system-ui, sans-serif',
      backgroundImage: `
        radial-gradient(ellipse at top, rgba(20, 232, 154, 0.04) 0%, transparent 45%),
        radial-gradient(ellipse at bottom, rgba(77, 186, 242, 0.02) 0%, transparent 45%)
      `,
    }}>
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

      <TopBar
        activeView={activeView}
        setActiveView={setActiveView}
        regime={regime}
        universeStats={{ core: 784, watchlist: 12 }}
      />

      {showUniverseBar && (
        <div className="sticky top-[80px] sm:top-[92px] z-30 border-b border-neutral-800/60 bg-[#0a0b0d]/95 backdrop-blur-xl">
          <div className="px-3 sm:px-6 py-2 max-w-[1400px] mx-auto">
            <UniverseSelector universe={universe} setUniverse={setUniverse} />
          </div>
        </div>
      )}

      <main>
        {activeView === 'board' && <ErrorBoundary label="Board"><LiveTargetBoard onOpenTarget={setSelectedTarget} universe={universe} /></ErrorBoundary>}
        {activeView === 'prophet' && <ErrorBoundary label="Prophet"><ProphetView /></ErrorBoundary>}
        {activeView === 'catalyst' && <ErrorBoundary label="Catalyst"><CatalystView universe={universe} /></ErrorBoundary>}
        {activeView === 'williams' && <ErrorBoundary label="Williams"><WilliamsView universe={universe} /></ErrorBoundary>}
        {activeView === 'lynch' && <ErrorBoundary label="Lynch"><LynchView universe={universe} /></ErrorBoundary>}
        {activeView === 'earnings' && <ErrorBoundary label="Earnings"><EarningsPlaysView universe={universe} /></ErrorBoundary>}
        {activeView === 'options' && <ErrorBoundary label="Options"><OptionsPlaysView universe={universe} /></ErrorBoundary>}
        {activeView === 'engine' && <ErrorBoundary label="Engine"><EngineTestView /></ErrorBoundary>}
        {activeView === 'backtest' && <ErrorBoundary label="Backtest"><BacktestView /></ErrorBoundary>}
        {activeView === 'chart' && <ErrorBoundary label="Chart"><ChartView /></ErrorBoundary>}
        {activeView === 'regime' && <ErrorBoundary label="Regime"><RegimeView regime={regime} /></ErrorBoundary>}
        {activeView === 'analysts' && <ErrorBoundary label="Analysts"><AnalystsView analysts={analysts} /></ErrorBoundary>}
        {activeView === 'alerts' && <ErrorBoundary label="Alerts"><AlertsView /></ErrorBoundary>}
        {activeView === 'journal' && <ErrorBoundary label="Journal"><JournalView /></ErrorBoundary>}
        {activeView === 'settings' && <ErrorBoundary label="Settings"><SettingsView /></ErrorBoundary>}
      </main>

      <TargetDetail target={selectedTarget} onClose={() => setSelectedTarget(null)} />

      <footer className="mt-16 py-6 border-t border-neutral-900 text-center">
        <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-neutral-600">
          TradeIQ Alpha · Personal · Not Financial Advice · v{APP_VERSION}
        </div>
      </footer>
    </div>
  );
}
