// useSortable hook + SortableTh component
// Standing-rule pattern (originally MarginIQ v2.40.33): every data table column
// must be sortable by clicking the column header. Use these helpers to wire it up.
//
//   const { sortKey, sortDir, sortBy, sortRows } = useSortable('composite', 'desc');
//   const sorted = sortRows(rawRows);
//   <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="composite">
//     Score
//   </SortableTh>
//
// Supports nested keys via dot notation: field="topBuyer.name"
// String comparison is locale-aware; numbers compare numerically; nulls go last.

import React, { useState, useCallback } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

export function useSortable(initialKey, initialDir = 'desc') {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState(initialDir);

  const sortBy = useCallback((key) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }, [sortKey]);

  const sortRows = useCallback((rows) => {
    if (!Array.isArray(rows) || !sortKey) return rows ?? [];
    const dirMul = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = pluck(a, sortKey);
      const bv = pluck(b, sortKey);
      const aNull = av === null || av === undefined || (typeof av === 'number' && !Number.isFinite(av));
      const bNull = bv === null || bv === undefined || (typeof bv === 'number' && !Number.isFinite(bv));
      if (aNull && bNull) return 0;
      if (aNull) return 1;  // nulls always last
      if (bNull) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dirMul;
      return String(av).localeCompare(String(bv)) * dirMul;
    });
  }, [sortKey, sortDir]);

  return { sortKey, sortDir, sortBy, sortRows };
}

function pluck(obj, path) {
  if (!obj) return null;
  if (!path.includes('.')) return obj[path];
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return null;
    cur = cur[part];
  }
  return cur ?? null;
}

export function SortableTh({ sortKey, sortDir, sortBy, field, align = 'left', children, className = '' }) {
  const active = sortKey === field;
  const Icon = active ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  const alignClass = align === 'right' ? 'text-right justify-end' : align === 'center' ? 'text-center justify-center' : 'text-left justify-start';
  return (
    <th className={`px-3 py-2.5 cursor-pointer select-none transition-colors hover:text-neutral-300 ${active ? 'text-emerald-400' : ''} ${className}`}>
      <button
        type="button"
        onClick={() => sortBy(field)}
        className={`flex items-center gap-1 w-full ${alignClass} font-mono uppercase tracking-widest text-[10px]`}
      >
        <span>{children}</span>
        <Icon className="h-3 w-3 opacity-60" />
      </button>
    </th>
  );
}
