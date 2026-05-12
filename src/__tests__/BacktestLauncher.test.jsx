import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { BacktestLauncher, __test_internals } from '../components/BacktestLauncher.jsx';

// Phase 4b-2 — launcher form tests.
//
// We exercise the component end-to-end against a mocked fetch, including
// the useStartBacktest mutation (not mocked). Each test renders a fresh
// QueryClient so state doesn't bleed across cases.
//
// Pinned contracts:
//   - default config matches the brief (dow/2018-01-01/monthly/prophet/topN=20/cap=$100k)
//   - non-prophet board buttons are disabled with the limitations tooltip
//   - selecting sp500 reveals the SurvivorshipBanner inline
//   - selecting russell2k reveals the amber pre-warning
//   - invalid startDate (<2018-01-01) blocks submit and shows aria-invalid
//   - submit calls /api/backtest-runs with the right config shape and
//     auto-selects the returned runId via setSelectedRunId
//   - 409 response renders the 'view existing run' deep link

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('BacktestLauncher', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('renders with defaults: dow, 2018-01-01, monthly, prophet, top-N=20, capital=$100k', () => {
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher /></Wrapper>);

    // DOW radio is selected (aria-checked); others not
    expect(screen.getByRole('radio', { name: /DOW/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /S&P 500/ })).toHaveAttribute('aria-checked', 'false');

    // Date defaults
    expect(screen.getByTestId('start-date')).toHaveValue('2018-01-01');

    // Rebalance MONTHLY selected
    expect(screen.getByRole('radio', { name: /^MONTHLY/ })).toHaveAttribute('aria-checked', 'true');

    // Board PROPHET selected, others disabled
    expect(screen.getByRole('radio', { name: /^PROPHET/ })).toHaveAttribute('aria-checked', 'true');

    // Top N + capital defaults
    expect(screen.getByTestId('top-n')).toHaveValue(20);
    expect(screen.getByTestId('initial-capital')).toHaveValue(100000);
  });

  it('renders non-prophet boards disabled with a tooltip pointing to BACKTEST_LIMITATIONS', () => {
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher /></Wrapper>);

    for (const name of ['CATALYST', 'INSIDER', 'WILLIAMS']) {
      const btn = screen.getByRole('radio', { name: new RegExp(`^${name}`) });
      expect(btn).toBeDisabled();
      expect(btn.title).toMatch(/BACKTEST_LIMITATIONS/);
    }
  });

  it('selecting S&P 500 reveals the inline SurvivorshipBanner', () => {
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher /></Wrapper>);

    // Initially (dow) the banner should NOT render — universe is corrected.
    expect(screen.queryByTestId('launcher-survivorship-prewarning')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /S&P 500/ }));
    expect(screen.getByTestId('launcher-survivorship-prewarning')).toBeInTheDocument();
    // Inside the wrapper, the actual SurvivorshipBanner test-id renders too.
    expect(screen.getByTestId('survivorship-banner')).toBeInTheDocument();
  });

  it('selecting Russell 2k reveals the amber 15-min pre-warning', () => {
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher /></Wrapper>);

    expect(screen.queryByTestId('russell2k-prewarning')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /RUSSELL 2K/ }));
    expect(screen.getByTestId('russell2k-prewarning')).toBeInTheDocument();
  });

  it('blocks submit and marks invalid when startDate is before 2018-01-01', async () => {
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher setSelectedRunId={() => {}} /></Wrapper>);

    // Set startDate to 2017-06-01 (before floor)
    fireEvent.change(screen.getByTestId('start-date'), { target: { value: '2017-06-01' } });
    // Submit
    fireEvent.click(screen.getByTestId('launch-submit'));
    // Validation fires on submit attempt (touched). aria-invalid asserted.
    await waitFor(() => {
      expect(screen.getByTestId('start-date')).toHaveAttribute('aria-invalid', 'true');
    });
    // Fetch must NOT have been called.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('happy path: submit POSTs the config to /api/backtest-runs and auto-selects returned runId', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ ok: true, runId: 'bt_new_123' }, { status: 202 }),
    );
    const setSelectedRunId = vi.fn();
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher setSelectedRunId={setSelectedRunId} /></Wrapper>);

    fireEvent.click(screen.getByTestId('launch-submit'));

    await waitFor(() => expect(screen.getByTestId('launch-success')).toBeInTheDocument());
    expect(screen.getByTestId('launch-success').textContent).toMatch(/bt_new_123/);

    // Fetch was called with the right shape.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/backtest-runs/start');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.universe).toBe('dow');
    expect(body.board).toBe('prophet');
    expect(body.rebalanceFrequency).toBe('monthly');
    expect(body.portfolio.topN).toBe(20);
    expect(body.initialCapital).toBe(100000);

    // setSelectedRunId fired with the new runId.
    expect(setSelectedRunId).toHaveBeenCalledWith('bt_new_123');
  });

  it('409 conflict: shows banner with "view existing run" deep link that calls setSelectedRunId', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse(
        { ok: false, error: 'A backtest is already running (runId: bt_existing).', runId: 'bt_existing' },
        { status: 409 },
      ),
    );
    const setSelectedRunId = vi.fn();
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher setSelectedRunId={setSelectedRunId} /></Wrapper>);

    fireEvent.click(screen.getByTestId('launch-submit'));
    await waitFor(() => expect(screen.getByTestId('launch-error')).toBeInTheDocument());

    expect(screen.getByTestId('launch-error').textContent).toMatch(/already running/i);
    // Deep link present and wired.
    const link = screen.getByTestId('launch-409-deeplink');
    fireEvent.click(link);
    expect(setSelectedRunId).toHaveBeenCalledWith('bt_existing');
  });

  it('shows the launching… spinner while the mutation is pending', async () => {
    // Hold the fetch promise open so we observe the pending UI state.
    let resolveFetch;
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher setSelectedRunId={() => {}} /></Wrapper>);
    fireEvent.click(screen.getByTestId('launch-submit'));
    await waitFor(() => expect(screen.getByTestId('launch-submit')).toBeDisabled());
    expect(screen.getByTestId('launch-submit').textContent).toMatch(/launching/i);
    resolveFetch(jsonResponse({ ok: true, runId: 'bt_done' }, { status: 202 }));
  });

  it('toggling Advanced shows/hides the advanced fieldset', () => {
    const { wrapper: Wrapper } = makeWrapper();
    render(<Wrapper><BacktestLauncher /></Wrapper>);
    expect(screen.queryByTestId('advanced-section')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('advanced-toggle'));
    expect(screen.getByTestId('advanced-section')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('advanced-toggle'));
    expect(screen.queryByTestId('advanced-section')).not.toBeInTheDocument();
  });
});

// Unit-level tests of the form helpers — quick coverage without rendering.

describe('BacktestLauncher form helpers', () => {
  const { validateForm, buildConfig, DEFAULT_CONFIG } = __test_internals;
  const fullForm = (overrides = {}) => ({
    ...DEFAULT_CONFIG,
    endDate: '2024-01-01',
    ...overrides,
  });

  it('validateForm returns empty on a valid baseline config', () => {
    expect(validateForm(fullForm())).toEqual({});
  });

  it('validateForm flags windows shorter than 90 days', () => {
    const errs = validateForm(fullForm({ startDate: '2018-01-01', endDate: '2018-02-15' }));
    expect(errs.endDate).toMatch(/90 days/i);
  });

  it('validateForm flags startDate < 2018-01-01', () => {
    const errs = validateForm(fullForm({ startDate: '2017-06-01' }));
    expect(errs.startDate).toMatch(/2018-01-01/);
  });

  it('validateForm flags topN out of range', () => {
    expect(validateForm(fullForm({ topN: 3 })).topN).toMatch(/5\.\.50/);
    expect(validateForm(fullForm({ topN: 100 })).topN).toMatch(/5\.\.50/);
  });

  it('buildConfig produces the exact BacktestConfig shape the trigger expects', () => {
    const cfg = buildConfig(fullForm());
    expect(cfg).toMatchObject({
      universe: 'dow',
      startDate: '2018-01-01',
      endDate: '2024-01-01',
      rebalanceFrequency: 'monthly',
      board: 'prophet',
      portfolio: {
        topN: 20,
        weighting: 'equal',
        maxPositionPct: 0.1,
        maxSectorPct: 0.4,
        cashSleeve: 0.05,
        minComposite: 50,
      },
      initialCapital: 100000,
    });
    // Slippage defaults present + commission zero.
    expect(cfg.costs.slippageBps.dow).toBe(3);
    expect(cfg.costs.commission).toBe(0);
  });
});
