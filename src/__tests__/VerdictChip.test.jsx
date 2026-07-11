// FIX-1 W4 — VerdictChip render tests: the chip must surface the measured
// verdict (with numbers) on every board it covers, and the tooltip must
// carry the run provenance.

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { VerdictChip } from '../components/VerdictChip.jsx';

describe('VerdictChip', () => {
  it('williams renders NO VALIDATED EDGE with the measured −73.4pp', () => {
    render(<VerdictChip board="williams" />);
    const chip = screen.getByTestId('verdict-chip-williams');
    expect(chip.textContent).toBe('NO VALIDATED EDGE (−73.4pp vs SPY)');
    expect(chip.getAttribute('title')).toContain('bt_20260519014409_zsxtsq');
  });

  it('lynch renders IC + pp figures', () => {
    render(<VerdictChip board="lynch" />);
    expect(screen.getByTestId('verdict-chip-lynch').textContent).toBe(
      'NO VALIDATED EDGE (IC 0.0011, −1.3pp vs SPY)',
    );
  });

  it('prophet renders MIXED with both benchmarks', () => {
    render(<VerdictChip board="prophet" />);
    expect(screen.getByTestId('verdict-chip-prophet').textContent).toBe(
      'MIXED (+80.9pp vs SPY, −58pp vs QQQ, 4/8 windows)',
    );
  });

  it('target renders NO VALIDATED EDGE after the FIX-1 W3 verdict', () => {
    render(<VerdictChip board="target" />);
    expect(screen.getByTestId('verdict-chip-target').textContent).toBe(
      'NO VALIDATED EDGE (IC -0.0105, −74.2pp vs SPY)',
    );
  });

  it('compact mode collapses to the bare status but keeps the full label in the tooltip', () => {
    render(<VerdictChip board="williams" compact />);
    const chip = screen.getByTestId('verdict-chip-williams');
    expect(chip.textContent).toBe('NO EDGE');
    expect(chip.getAttribute('title')).toContain('NO VALIDATED EDGE (−73.4pp vs SPY)');
  });

  it('renders nothing for a board with no registry entry', () => {
    const { container } = render(<VerdictChip board="catalyst" />);
    expect(container.firstChild).toBeNull();
  });
});
