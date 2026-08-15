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

  it('lynch renders IC + pp figures (AUDIT-1 corrected attribution)', () => {
    render(<VerdictChip board="lynch" />);
    expect(screen.getByTestId('verdict-chip-lynch').textContent).toBe(
      'NO VALIDATED EDGE (IC -0.0612, −101pp vs SPY)',
    );
  });

  it('prophet renders PENDING — the prior +80.9pp figure was not a measurement', () => {
    render(<VerdictChip board="prophet" />);
    expect(screen.getByTestId('verdict-chip-prophet').textContent).toBe(
      'EDGE PENDING VALIDATION',
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
    // BROKER-1 W1 changed the EXAMPLE, not the rule. 'catalyst' used to be
    // the unregistered case; it is now registered UNMEASURED, which was the
    // whole point of W1. The behaviour itself still needs pinning, so this
    // uses an id that is genuinely absent.
    const { container } = render(<VerdictChip board="not-a-board" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders NOT MEASURED for a board that ships without a measurement', () => {
    // The inverse of the case above, and the reason W1 exists: catalyst is
    // reachable, has an order row, and previously rendered no chip at all.
    render(<VerdictChip board="catalyst" />);
    const chip = screen.getByTestId('verdict-chip-catalyst');
    expect(chip.textContent).toBe('NOT MEASURED');
    expect(chip.getAttribute('title')).toContain('Never backtested');
  });

  it('does not colour an unmeasured board like a failed one', () => {
    // Absence of evidence is not evidence of failure; rose is NO_EDGE's.
    render(<VerdictChip board="catalyst" />);
    expect(screen.getByTestId('verdict-chip-catalyst').className).not.toMatch(/rose/);
  });
});
