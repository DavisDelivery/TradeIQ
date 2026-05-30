// Phase 6 W2 — placeholder for a detail-panel section whose content lands in
// a later workstream (PR-C charts, PR-D fundamental charts, PR-E metrics /
// catalysts / risks / score breakdown).
//
// This is deliberately NOT a fake/empty section: it paints the section's
// title in its final position (so the panel's top-to-bottom section order is
// real and reviewable now) and a labelled "arrives in <PR>" note over a
// subtle skeleton, so the shell reads as intentionally-staged rather than
// broken. Each stub is replaced in-place by its real component later.

import React from 'react';

export function SectionStub({ title, arrivesIn, lines = 3 }) {
  return (
    <section
      data-testid={`section-stub-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`}
      className="border border-neutral-800/80 border-dashed bg-neutral-950/30 p-4"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          {title}
        </div>
        {arrivesIn && (
          <div className="text-[9px] uppercase tracking-widest font-mono text-neutral-600">
            arrives in {arrivesIn}
          </div>
        )}
      </div>
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="h-2.5 bg-neutral-800/40 animate-pulse"
            style={{ width: `${100 - i * 12}%` }}
          />
        ))}
      </div>
    </section>
  );
}
