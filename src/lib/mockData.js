// Mock data shared across views.
//
// Phase 2 split: these were inline in App.jsx; centralizing them so each
// extracted view can import only what it needs. Once a view is fully
// wired to a real API the corresponding MOCK can be deleted from this
// file — but Phase 2 is not the time to do that work; we keep MOCK
// fallbacks intact so views remain renderable in dev / when an endpoint
// is down.

export const MOCK_REGIME = {
  regime: 'risk_on',
  conviction: 'medium',
  vol: { level: 13.8, regime: 'low', trend: 'falling', percentile: 18 },
  rates: { tenYear: 4.12, twoTenSpread: 22, curveRegime: 'normal', trend: 'stable' },
  riskAppetite: { ratioTrend: 'risk_on_rising', creditSignal: 'tightening_spreads' },
  rationale: 'Risk-on regime (medium): VIX 13.8 (low, falling), 2y10y normal 22bp, risk on rising, tightening spreads',
  computedAt: new Date().toISOString(),
};

export const MOCK_TARGETS = [
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

export const MOCK_ANALYSTS = [
  { name: 'technical-analyst', label: 'Technical', signalsToday: 142, accuracy7d: 0.68, cost: 0, status: 'healthy' },
  { name: 'sector-rotation', label: 'Sector Rotation', signalsToday: 68, accuracy7d: 0.64, cost: 0, status: 'healthy' },
  { name: 'fundamental-analyst', label: 'Fundamental', signalsToday: 31, accuracy7d: 0.72, cost: 0, status: 'healthy' },
  { name: 'news-sentiment', label: 'News Sentiment', signalsToday: 89, accuracy7d: 0.58, cost: 1.85, status: 'healthy' },
  { name: 'flow-analyst', label: 'Flow', signalsToday: 47, accuracy7d: 0.75, cost: 0, status: 'healthy' },
  { name: 'earnings-analyst', label: 'Earnings', signalsToday: 12, accuracy7d: 0.71, cost: 0, status: 'healthy' },
  { name: 'geopolitical-analyst', label: 'Geopolitical', signalsToday: 23, accuracy7d: 0.52, cost: 0.45, status: 'healthy' },
  { name: 'macro-regime', label: 'Macro Regime', signalsToday: 1, accuracy7d: null, cost: 0, status: 'healthy' },
];

export const MOCK_ALERTS = [
  { id: 1, ticker: 'NVDA', tier: 'A', composite: 91, direction: 'long', firedAt: new Date(Date.now() - 14400000).toISOString(), delivered: true },
  { id: 2, ticker: 'TSLA', tier: 'A', composite: 90, direction: 'short', firedAt: new Date(Date.now() - 86400000).toISOString(), delivered: true },
  { id: 3, ticker: 'META', tier: 'A', composite: 93, direction: 'long', firedAt: new Date(Date.now() - 172800000).toISOString(), delivered: true },
];

export const MOCK_EQUITY_CURVE = Array.from({ length: 60 }, (_, i) => ({
  day: i,
  date: new Date(Date.now() - (60 - i) * 86400000).toISOString().slice(5, 10),
  equity: 10000 + Math.sin(i / 6) * 600 + i * 35 + (Math.random() - 0.5) * 200,
}));

export const MOCK_EARNINGS = [
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

export const MOCK_OPTIONS_PLAYS = [
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
