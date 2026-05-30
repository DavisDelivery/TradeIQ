// Shared formatters and small visual helpers used across views.
//
// .jsx because directionIcon and analystIcon return JSX.

import React from 'react';
import {
  ArrowUpRight, ArrowDownRight, Minus, LineChart as LineChartIcon, Layers,
  BarChart3, Newspaper, Cpu, Zap, Globe2, Gauge, Landmark, Eye, FlaskConical,
} from 'lucide-react';

export const fmt = {
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

// Phase 6 PR-G — small metric formatters reused across the board tables'
// new sortable Mcap/P-E/P-S/ROE/D-E columns.
export const fmtMcap = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
export const fmtNum1 = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(1));
export const fmtNum2 = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(2));
export const fmtPct1 = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`);

// Tolerates invalid / missing dates without throwing.
export const safeTimestamp = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
};

export const tierColor = (tier) => ({
  A: '#14e89a', B: '#4dbaf2', C: '#ffb020', D: '#5a6373',
}[tier] || '#5a6373');

export const tierGlow = (tier) => ({
  A: '0 0 24px -4px #14e89a77', B: '0 0 16px -4px #4dbaf255', C: '', D: '',
}[tier] || '');

export const directionIcon = (d) =>
  d === 'long' ? <ArrowUpRight className="h-3 w-3" /> :
  d === 'short' ? <ArrowDownRight className="h-3 w-3" /> :
  <Minus className="h-3 w-3" />;

export const analystIcon = {
  'technical-analyst': LineChartIcon,
  'sector-rotation': Layers,
  'fundamental-analyst': BarChart3,
  'news-sentiment': Newspaper,
  'flow-analyst': Cpu,
  'earnings-analyst': Zap,
  'geopolitical-analyst': Globe2,
  'macro-regime': Gauge,
  'political-analyst': Landmark,
  'insider-analyst': Eye,
  'patent-analyst': FlaskConical,
};

export const analystLabel = {
  'technical-analyst': 'Technical',
  'sector-rotation': 'Sector',
  'fundamental-analyst': 'Fundamental',
  'news-sentiment': 'News',
  'flow-analyst': 'Flow',
  'earnings-analyst': 'Earnings',
  'geopolitical-analyst': 'Geo',
  'macro-regime': 'Macro',
  'political-analyst': 'Political',
  'insider-analyst': 'Insider',
  'patent-analyst': 'Patents',
};

// Compact dollar formatter — used by earnings and options views.
export const fmtCompact = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
