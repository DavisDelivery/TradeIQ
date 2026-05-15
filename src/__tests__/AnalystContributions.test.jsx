import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  AnalystContributions,
  StatusBadge,
  provenanceFor,
  _internals,
} from '../components/AnalystContributions.jsx';

// Phase 4f W5 — provenance + badge contract.
//
// Three states the panel must visually distinguish:
//   - LIVE     (green)   — analyst produced a real signal this snapshot
//   - NO DATA  (gray)    — analyst's upstream was empty this snapshot;
//                          weight rescaled away by composeWeights
//   - REMOVED  (gray)    — analyst permanently removed from BASE_WEIGHTS
//                          (currently macro-regime, patent-analyst per
//                          Phase 4f-finish audit § 2)

const sampleTarget = {
  scoredAnalysts: [
    'technical-analyst',
    'sector-rotation',
    'fundamental-analyst',
    'flow-analyst',
    'earnings-analyst',
    'insider-analyst',
    'political-analyst',
  ],
  noDataAnalysts: ['news-sentiment'],
  analystContributions: [
    { analyst: 'technical-analyst',   score: 78, direction: 'long',    weight: 0.17 },
    { analyst: 'sector-rotation',     score: 65, direction: 'long',    weight: 0.09 },
    { analyst: 'fundamental-analyst', score: 60, direction: 'long',    weight: 0.15 },
    { analyst: 'flow-analyst',        score: 55, direction: 'neutral', weight: 0.11 },
    { analyst: 'news-sentiment',      score: 50, direction: 'neutral', weight: 0 },
    { analyst: 'earnings-analyst',    score: 58, direction: 'long',    weight: 0.08 },
    { analyst: 'macro-regime',        score: 50, direction: 'neutral', weight: 0 },
    { analyst: 'insider-analyst',     score: 72, direction: 'long',    weight: 0.16 },
    { analyst: 'patent-analyst',      score: 50, direction: 'neutral', weight: 0 },
    { analyst: 'political-analyst',   score: 68, direction: 'long',    weight: 0.11 },
  ],
};

describe('provenanceFor', () => {
  it('classifies permanently-removed analysts as removed', () => {
    expect(provenanceFor('macro-regime', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('removed');
    expect(provenanceFor('patent-analyst', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('removed');
  });

  it('classifies no-data analysts as no_data', () => {
    expect(provenanceFor('news-sentiment', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('no_data');
  });

  it('classifies scored analysts as live', () => {
    expect(provenanceFor('technical-analyst', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('live');
    expect(provenanceFor('insider-analyst', sampleTarget.scoredAnalysts, sampleTarget.noDataAnalysts))
      .toBe('live');
  });

  it('removed takes precedence over no_data (defensive)', () => {
    // If macro-regime ever ALSO ended up in noDataAnalysts (e.g. via a
    // future provider change), the structural REMOVED classification
    // should still win — it's documenting that the analyst was pulled
    // from the weight table, not just that this snapshot is empty.
    expect(provenanceFor('macro-regime', [], ['macro-regime']))
      .toBe('removed');
  });

  it('handles missing arrays gracefully', () => {
    expect(provenanceFor('technical-analyst', undefined, undefined)).toBe('live');
    expect(provenanceFor('news-sentiment', null, null)).toBe('live'); // no longer no_data without list
  });

  it('PERMANENTLY_REMOVED set documents the live removals', () => {
    expect(_internals.PERMANENTLY_REMOVED.has('macro-regime')).toBe(true);
    expect(_internals.PERMANENTLY_REMOVED.has('patent-analyst')).toBe(true);
    expect(_internals.PERMANENTLY_REMOVED.size).toBe(2);
  });
});

describe('StatusBadge', () => {
  it('renders LIVE for status="live"', () => {
    render(<StatusBadge status="live" />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('renders NO DATA for status="no_data"', () => {
    render(<StatusBadge status="no_data" />);
    expect(screen.getByText('NO DATA')).toBeInTheDocument();
  });

  it('renders REMOVED for status="removed"', () => {
    render(<StatusBadge status="removed" />);
    expect(screen.getByText('REMOVED')).toBeInTheDocument();
  });

  it('renders nothing for unknown / null status', () => {
    const { container: c1 } = render(<StatusBadge status={null} />);
    expect(c1).toBeEmptyDOMElement();
    const { container: c2 } = render(<StatusBadge status="banana" />);
    expect(c2).toBeEmptyDOMElement();
  });

  it('LIVE uses emerald color class (visual contract)', () => {
    render(<StatusBadge status="live" />);
    const el = screen.getByText('LIVE');
    expect(el.className).toMatch(/emerald/);
  });

  it('REMOVED uses neutral-700 class (struck-through styling)', () => {
    render(<StatusBadge status="removed" />);
    const el = screen.getByText('REMOVED');
    expect(el.className).toMatch(/neutral-/);
  });
});

describe('AnalystContributions', () => {
  it('renders nothing when target is null', () => {
    const { container } = render(<AnalystContributions target={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per analyst contribution', () => {
    render(<AnalystContributions target={sampleTarget} />);
    expect(screen.getAllByText('LIVE').length).toBe(sampleTarget.scoredAnalysts.length);
    expect(screen.getAllByText('NO DATA').length).toBe(1);   // news-sentiment
    expect(screen.getAllByText('REMOVED').length).toBe(2);   // macro + patent
  });

  it('replaces removed analyst score with an em-dash', () => {
    render(<AnalystContributions target={sampleTarget} />);
    // Each removed analyst's score cell renders "—" instead of "50".
    // There are 2 removed rows + 1 weight column on each line ("—"
    // also appears for missing weights). Count by looking for at
    // least 2 em-dashes in the rendered output.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('honors target.scoredAnalysts to mark LIVE rows', () => {
    render(<AnalystContributions target={sampleTarget} />);
    // technical-analyst is in scoredAnalysts → must be LIVE
    // (smoke test — re-verifies provenanceFor wiring through render)
    const liveBadges = screen.getAllByText('LIVE');
    expect(liveBadges.length).toBe(7);
  });

  it('renders empty when analystContributions is empty array', () => {
    const empty = { ...sampleTarget, analystContributions: [] };
    render(<AnalystContributions target={empty} />);
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
    expect(screen.queryByText('NO DATA')).not.toBeInTheDocument();
    expect(screen.queryByText('REMOVED')).not.toBeInTheDocument();
  });

  it('renders unknown analyst names as-is (no crash on label lookup)', () => {
    const mystery = {
      scoredAnalysts: ['quantum-vibes'],
      noDataAnalysts: [],
      analystContributions: [
        { analyst: 'quantum-vibes', score: 77, direction: 'long', weight: 1 },
      ],
    };
    render(<AnalystContributions target={mystery} />);
    expect(screen.getByText('quantum-vibes')).toBeInTheDocument();
  });
});
