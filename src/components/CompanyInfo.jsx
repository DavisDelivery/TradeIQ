// Phase 4j W4 — CompanyInfo block for the detail panel.
//
// Renders the GET /api/ticker-info payload: logo (with ticker-monogram
// fallback when Polygon has no branding), company name, industry,
// description paragraph, and key facts (employees, market cap, IPO/list
// date, homepage link). Sits near the top of the detail panel so a user
// reads "what is this company" before "what do the analysts think."
//
// Responsive: stacks vertically on phone, side-by-side logo + body on
// desktop. The description paragraph wraps to whatever column width the
// container gives it - the detail-panel modal is max-w-5xl on desktop,
// full-width on phone.

import React, { useState, useEffect } from 'react';
import { ExternalLink, Building2 } from 'lucide-react';

// Lightweight formatters - we don't import from src/lib/formatters.jsx
// because the panel needs slightly different rules (compact market cap
// in B/T, comma-grouped employees, year-only IPO date).
function formatMarketCap(n) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

function formatEmployees(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toLocaleString('en-US');
}

function formatListDate(s) {
  if (!s || typeof s !== 'string') return null;
  // Polygon ships YYYY-MM-DD. Display as "Listed YYYY" - enough context
  // without the panel getting noisy with full dates.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  return m[1];
}

// Ticker monogram fallback: first 1-2 chars of the symbol on a tinted
// background. Used when Polygon has no branding image.
function LogoMonogram({ ticker }) {
  const initials = (ticker ?? '').slice(0, 2).toUpperCase();
  return (
    <div className="flex h-14 w-14 sm:h-16 sm:w-16 flex-shrink-0 items-center justify-center border border-neutral-800 bg-neutral-900/60 font-mono text-sm sm:text-base font-semibold tracking-wider text-neutral-300">
      {initials}
    </div>
  );
}

function Logo({ url, ticker }) {
  const [errored, setErrored] = useState(false);
  // Reset error state whenever the URL changes - we don't want one
  // ticker's failed logo to stick to the next one opened.
  useEffect(() => { setErrored(false); }, [url]);
  if (!url || errored) return <LogoMonogram ticker={ticker} />;
  return (
    <div className="flex h-14 w-14 sm:h-16 sm:w-16 flex-shrink-0 items-center justify-center border border-neutral-800 bg-white/90 p-1.5">
      <img
        src={url}
        alt={`${ticker} logo`}
        className="max-h-full max-w-full object-contain"
        onError={() => setErrored(true)}
      />
    </div>
  );
}

function KeyFact({ label, value }) {
  if (value == null) return null;
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-widest font-mono text-neutral-500">{label}</span>
      <span className="text-[12px] font-mono text-neutral-200 mt-0.5 tabular-nums">{value}</span>
    </div>
  );
}

export function CompanyInfo({ ticker }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInfo(null);
    fetch(`/api/ticker-info?ticker=${encodeURIComponent(ticker)}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
        return json;
      })
      .then((json) => {
        if (cancelled) return;
        setInfo(json);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticker]);

  if (loading) {
    return (
      <div className="border border-neutral-800 p-4 sm:p-5">
        <div className="flex items-start gap-4">
          <div className="h-14 w-14 sm:h-16 sm:w-16 flex-shrink-0 border border-neutral-800 bg-neutral-900/40 animate-pulse" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-32 bg-neutral-800/80 animate-pulse" />
            <div className="h-2 w-24 bg-neutral-800/60 animate-pulse" />
            <div className="h-2 w-full bg-neutral-800/50 animate-pulse mt-3" />
            <div className="h-2 w-5/6 bg-neutral-800/50 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-neutral-800 p-4 sm:p-5 text-[12px] text-neutral-500 font-mono">
        <div className="flex items-center gap-2">
          <Building2 className="h-3.5 w-3.5" />
          <span>Company info unavailable · {error}</span>
        </div>
      </div>
    );
  }

  if (!info) return null;

  const marketCap = formatMarketCap(info.marketCap);
  const employees = formatEmployees(info.employees);
  const listed = formatListDate(info.listDate);

  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-4 sm:p-5">
      <div className="flex flex-col sm:flex-row items-start gap-4">
        <Logo url={info.logoUrl} ticker={info.ticker} />

        <div className="flex-1 min-w-0 w-full">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-serif font-semibold text-lg sm:text-xl text-neutral-100 leading-tight">
              {info.name || info.ticker}
            </h3>
            {info.industry && (
              <span className="text-[10px] uppercase tracking-widest font-mono text-neutral-500">
                {info.industry}
              </span>
            )}
          </div>

          {info.description ? (
            <p className="mt-3 text-[13px] leading-relaxed text-neutral-300">
              {info.description}
            </p>
          ) : (
            <p className="mt-3 text-[12px] italic text-neutral-500 font-mono">
              No company description available.
            </p>
          )}

          {(marketCap || employees || listed || info.homepageUrl) && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-5">
              <KeyFact label="Market Cap" value={marketCap} />
              <KeyFact label="Employees" value={employees} />
              <KeyFact label="Listed" value={listed} />
              {info.homepageUrl && (
                <div className="flex flex-col">
                  <span className="text-[9px] uppercase tracking-widest font-mono text-neutral-500">Site</span>
                  <a
                    href={info.homepageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] font-mono text-emerald-400 hover:text-emerald-300 mt-0.5 inline-flex items-center gap-1 truncate"
                    title={info.homepageUrl}
                  >
                    {info.homepageUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                    <ExternalLink className="h-3 w-3 flex-shrink-0" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
