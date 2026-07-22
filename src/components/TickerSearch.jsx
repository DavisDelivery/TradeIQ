import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useSymbolSearch } from '../hooks/useSymbolSearch.js';

// Global header search: type a ticker or company name, pick a result, and the
// caller opens that company's full profile (chart, AI thesis, fundamentals,
// info) via onSelect(ticker).
//
// Layout: the in-flow footprint is just a 32px icon button (same size as the
// theme toggle it replaces), so it never crowds the tight mobile header. On
// activation it expands into an absolutely-positioned panel (right-aligned,
// overlaying leftward) holding the input + results — out of flow, so no
// header overflow at any width. 200ms debounce, ↑/↓+Enter, Esc/×/outside to
// close.
export function TickerSearch({ onSelect, className = '' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  // Debounce the query feeding the request so each keystroke isn't a fetch.
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data: results = [], isFetching } = useSymbolSearch(open ? dq : '');

  useEffect(() => { setActive(0); }, [results]);

  // Focus the input the moment the panel opens.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Click-outside / Escape close the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => { setOpen(false); setQ(''); setDq(''); };

  const choose = (r) => {
    if (!r) return;
    onSelect?.(r.ticker);
    close();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (q) { setQ(''); setDq(''); }
      else close();
    }
  };

  const showDropdown = open && dq.trim().length >= 1;

  return (
    <div ref={rootRef} className={`relative flex-shrink-0 ${className}`}>
      {/* Collapsed trigger — matches the theme toggle's footprint. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Search ticker or company"
        aria-expanded={open}
        data-testid="ticker-search-trigger"
        className="inline-flex items-center justify-center h-8 w-8 border border-neutral-800 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600 transition-colors"
      >
        <Search className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-0 z-[60] w-[min(78vw,320px)]">
          <div className="flex items-center gap-1.5 h-8 px-2.5 border border-neutral-600 bg-[#0a0b0d] shadow-2xl">
            <Search className="h-3.5 w-3.5 text-neutral-500 flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search ticker or company…"
              aria-label="Search ticker or company"
              autoComplete="off"
              spellCheck={false}
              data-testid="ticker-search-input"
              className="w-full min-w-0 bg-transparent text-[13px] text-neutral-100 placeholder:text-neutral-600 outline-none"
            />
            <button
              type="button"
              onClick={close}
              aria-label="Close search"
              className="flex-shrink-0 text-neutral-500 hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {showDropdown && (
            <div
              role="listbox"
              data-testid="ticker-search-results"
              className="mt-1 max-h-[60vh] overflow-y-auto border border-neutral-800 bg-[#0a0b0d] shadow-2xl"
            >
              {results.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-neutral-500 font-mono">
                  {isFetching ? 'searching…' : 'no matches'}
                </div>
              ) : (
                results.map((r, i) => (
                  <button
                    key={r.ticker}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(r)}
                    className={`w-full flex items-baseline gap-2 px-3 py-2 text-left transition-colors ${
                      i === active ? 'bg-emerald-500/10' : 'hover:bg-neutral-900/60'
                    }`}
                  >
                    <span className="font-serif font-bold text-[13px] text-neutral-100 flex-shrink-0">{r.ticker}</span>
                    {r.name && <span className="text-[11px] text-neutral-500 truncate">{r.name}</span>}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TickerSearch;
