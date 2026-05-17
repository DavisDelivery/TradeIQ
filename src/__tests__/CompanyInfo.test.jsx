// Phase 4j W4 — CompanyInfo component tests.
//
// Mocks the /api/ticker-info fetch and verifies the panel renders:
//   - logo (or ticker-monogram fallback when absent)
//   - company name + industry
//   - description paragraph (or graceful empty state)
//   - key facts (employees, market cap, listed year, homepage)
//   - loading + error states

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { CompanyInfo } from '../components/CompanyInfo.jsx';

function mockFetchOnce(payload, { ok = true, status = 200 } = {}) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok,
    status,
    json: async () => payload,
  });
}

beforeEach(() => {
  // Default: leave fetch unset; each test installs its own mock.
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CompanyInfo', () => {
  it('renders the company name + industry on a successful load', async () => {
    mockFetchOnce({
      ok: true,
      ticker: 'AAPL',
      name: 'Apple Inc.',
      description: 'Apple designs and sells consumer electronics.',
      homepageUrl: 'https://www.apple.com',
      logoUrl: 'https://api.polygon.io/logo.svg?apiKey=k',
      employees: 164000,
      marketCap: 3000000000000,
      listDate: '1980-12-12',
      industry: 'ELECTRONIC COMPUTERS',
    });
    render(<CompanyInfo ticker="AAPL" />);
    expect(await screen.findByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('ELECTRONIC COMPUTERS')).toBeInTheDocument();
    expect(
      screen.getByText('Apple designs and sells consumer electronics.'),
    ).toBeInTheDocument();
  });

  it('formats market cap as $X.XXT for trillion-scale companies', async () => {
    mockFetchOnce({
      ok: true,
      ticker: 'AAPL',
      name: 'Apple Inc.',
      description: 'desc',
      homepageUrl: null,
      logoUrl: null,
      employees: null,
      marketCap: 3000000000000,
      listDate: null,
      industry: null,
    });
    render(<CompanyInfo ticker="AAPL" />);
    expect(await screen.findByText('$3.00T')).toBeInTheDocument();
  });

  it('formats market cap as $X.XXB for billion-scale companies', async () => {
    mockFetchOnce({
      ok: true,
      ticker: 'SMTC',
      name: 'Semtech',
      description: 'desc',
      homepageUrl: null,
      logoUrl: null,
      employees: 1200,
      marketCap: 1500000000,
      listDate: null,
      industry: null,
    });
    render(<CompanyInfo ticker="SMTC" />);
    expect(await screen.findByText('$1.50B')).toBeInTheDocument();
    expect(screen.getByText('1,200')).toBeInTheDocument();
  });

  it('renders the ticker-monogram fallback when no logo URL is provided', async () => {
    mockFetchOnce({
      ok: true,
      ticker: 'OBSC',
      name: 'OBSC',
      description: null,
      homepageUrl: null,
      logoUrl: null,
      employees: null,
      marketCap: null,
      listDate: null,
      industry: null,
    });
    render(<CompanyInfo ticker="OBSC" />);
    // Monogram shows the first two chars of the ticker (uppercase).
    expect(await screen.findByText('OB')).toBeInTheDocument();
  });

  it('renders a graceful empty state when description is null', async () => {
    mockFetchOnce({
      ok: true,
      ticker: 'OBSC',
      name: 'OBSC',
      description: null,
      homepageUrl: null,
      logoUrl: null,
      employees: null,
      marketCap: null,
      listDate: null,
      industry: null,
    });
    render(<CompanyInfo ticker="OBSC" />);
    expect(
      await screen.findByText(/No company description available/i),
    ).toBeInTheDocument();
  });

  it('shows the year (not full date) when list_date is present', async () => {
    mockFetchOnce({
      ok: true,
      ticker: 'AAPL',
      name: 'Apple Inc.',
      description: 'desc',
      homepageUrl: null,
      logoUrl: null,
      employees: null,
      marketCap: null,
      listDate: '1980-12-12',
      industry: null,
    });
    render(<CompanyInfo ticker="AAPL" />);
    expect(await screen.findByText('1980')).toBeInTheDocument();
  });

  it('strips protocol from the homepage URL for display', async () => {
    mockFetchOnce({
      ok: true,
      ticker: 'AAPL',
      name: 'Apple Inc.',
      description: 'desc',
      homepageUrl: 'https://www.apple.com',
      logoUrl: null,
      employees: null,
      marketCap: null,
      listDate: null,
      industry: null,
    });
    render(<CompanyInfo ticker="AAPL" />);
    expect(await screen.findByText('apple.com')).toBeInTheDocument();
  });

  it('renders an error state when /api/ticker-info fails', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'firestore down' }),
    });
    render(<CompanyInfo ticker="AAPL" />);
    expect(
      await screen.findByText(/Company info unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/firestore down/i)).toBeInTheDocument();
  });

  it('refetches when the ticker prop changes', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true, ticker: 'AAPL', name: 'Apple Inc.',
          description: 'A', homepageUrl: null, logoUrl: null,
          employees: null, marketCap: null, listDate: null, industry: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true, ticker: 'TSLA', name: 'Tesla Inc.',
          description: 'B', homepageUrl: null, logoUrl: null,
          employees: null, marketCap: null, listDate: null, industry: null,
        }),
      });
    const { rerender } = render(<CompanyInfo ticker="AAPL" />);
    expect(await screen.findByText('Apple Inc.')).toBeInTheDocument();
    rerender(<CompanyInfo ticker="TSLA" />);
    await waitFor(() => expect(screen.queryByText('Apple Inc.')).not.toBeInTheDocument());
    expect(screen.getByText('Tesla Inc.')).toBeInTheDocument();
  });
});
