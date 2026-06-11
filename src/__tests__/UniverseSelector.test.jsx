// Wave 4D (code-review-2026-06 m2) — UNIVERSE_AWARE_VIEWS honesty.
//
// The set must list exactly the views whose data actually varies with the
// universe prop. 'earnings' and 'options' were listed but their views
// ignore the prop, so the selector visibly did nothing; 'insiders' was
// missing even though InsiderBoardView sends `index=${universe}` to the
// server — the board was silently filtered by a universe chosen on
// another tab.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  UniverseSelector,
  UNIVERSE_AWARE_VIEWS,
  UNIVERSE_OPTIONS,
} from '../components/UniverseSelector.jsx';

describe('UNIVERSE_AWARE_VIEWS', () => {
  it('lists exactly the views that consume the universe prop', () => {
    expect([...UNIVERSE_AWARE_VIEWS].sort()).toEqual(
      ['board', 'catalyst', 'insiders', 'lynch', 'williams'].sort(),
    );
  });

  it('includes insiders (InsiderBoardView sends index=${universe})', () => {
    expect(UNIVERSE_AWARE_VIEWS.has('insiders')).toBe(true);
  });

  it('excludes earnings and options (their views ignore the prop)', () => {
    expect(UNIVERSE_AWARE_VIEWS.has('earnings')).toBe(false);
    expect(UNIVERSE_AWARE_VIEWS.has('options')).toBe(false);
  });
});

describe('UniverseSelector', () => {
  it('renders all universe options and reports clicks', () => {
    const setUniverse = vi.fn();
    render(<UniverseSelector universe="sp500" setUniverse={setUniverse} />);
    for (const opt of UNIVERSE_OPTIONS) {
      expect(screen.getByText(opt.label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('Dow 30'));
    expect(setUniverse).toHaveBeenCalledWith('dow');
  });
});
