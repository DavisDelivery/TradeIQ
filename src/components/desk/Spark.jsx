// DESK-1 W2 — inline SVG sparkline for the watchlist table.
// Pure presentational: takes the 30-close array from /api/desk-stats.
// Stroke is neutral; red/green is reserved for SIGNED values per the
// Desk palette rule, and a sparkline is a shape, not a signed number.

import React from 'react';

export function Spark({ values, width = 72, height = 20, className = '' }) {
  const vals = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vals.length < 2) {
    return <span className="text-neutral-700 font-mono text-[10px]">—</span>;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = width / (vals.length - 1);
  const pad = 1.5;
  const points = vals
    .map((v, i) => {
      const x = i * stepX;
      const y = pad + (height - 2 * pad) * (1 - (v - min) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label="30-day price sparkline"
    >
      <polyline
        points={points}
        fill="none"
        stroke="#a3a3a3"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
