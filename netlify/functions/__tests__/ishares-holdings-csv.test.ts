// Tests for scripts/lib/ishares-holdings-csv.ts.
// Hermetic — no network. Fixtures lift the actual head + sample rows
// returned by ishares.com for IVV (2018-01-31) and IWM, plus a "no-data"
// preamble that the live fetch returns for pre-archive / weekend dates.

import { describe, it, expect } from 'vitest';
import { parseIsharesHoldingsCsv } from '../../../scripts/lib/ishares-holdings-csv';

const IVV_2018_01_31_HEAD = `﻿iShares Core S&P 500 ETF
Fund Holdings as of,"Jan 31, 2018"
Inception Date,"May 15, 2000"
Shares Outstanding,"549,650,000.00"
Stock,"-"
Bond,"-"
Cash,"-"
Other,"-"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date
"AAPL","APPLE INC","Information Technology","Equity","5,575,302,468.72","3.56","5,575,302,468.72","33,299,304.00","167.43","United States","NASDAQ","USD","1.00","USD","-"
"MSFT","MICROSOFT CORP","Information Technology","Equity","4,753,710,102.87","3.03","4,753,710,102.87","50,033,787.00","95.01","United States","NASDAQ","USD","1.00","USD","-"
"AMZN","AMAZON COM INC","Consumer Discretionary","Equity","3,763,623,168.90","2.40","3,763,623,168.90","2,594,010.00","1,450.89","United States","NASDAQ","USD","1.00","USD","-"
"FB","FACEBOOK CLASS A INC","Information Technology","Equity","2,890,563,526.73","1.84","2,890,563,526.73","15,466,657.00","186.89","United States","NASDAQ","USD","1.00","USD","-"
"BRKB","BERKSHIRE HATHAWAY INC CLASS B","Financials","Equity","2,675,666,275.38","1.71","2,675,666,275.38","12,480,951.00","214.38","United States","NYSE","USD","1.00","USD","-"

`;

const IWM_TYPICAL_HEAD = `iShares Russell 2000 ETF
Fund Holdings as of,"Apr 30, 2024"
Inception Date,"May 22, 2000"

Ticker,Name,Sector,Asset Class,Market Value
"AAON","AAON INC","Industrials","Equity","123,456,789.00"
"AAT","AMERICAN ASSETS TRUST INC","Real Estate","Equity","12,345,678.00"
"BRK.B","BERKSHIRE HATHAWAY","Financials","Equity","99,999.00"

`;

const NO_DATA_PREAMBLE = `iShares Core S&P 500 ETF
Fund Holdings as of,"-"
Inception Date,"May 15, 2000"
Shares Outstanding,"-"
Stock,"-"
Bond,"-"
Cash,"-"
Other,"-"
`;

// The iShares CSV parser filters by *ticker shape*, not by name. The
// "-" placeholder, lowercase, non-alnum, and length-over-6 cases are
// rejected. Tickers that happen to look like uppercase identifiers
// (e.g. "USD") would survive — iShares simply doesn't emit name-coded
// cash sleeves in the holdings CSV the way SSGA's xlsx does, so the
// parser doesn't need a CASH/USD/MM_FUND name filter.
const NOISY_PREAMBLE_AND_FOOTER = `Some Header
﻿Ignore me
Random metadata line
Ticker,Name,Sector,Asset Class
"AAA","ALPHA CORP","Industrials","Equity"
"BBB","BETA CORP","Industrials","Equity"
"-","CASH USD","Cash","Cash"
"MM_FUND","MONEY MARKET","Cash","Cash"
"TOOLONG7","BAD TICKER","Equity","Equity"
"low3r","BAD CASE","Equity","Equity"

Disclosure: this is footer text and should not be parsed.
`;

describe('parseIsharesHoldingsCsv', () => {
  it('parses an IVV-style header and returns the listed tickers in order', () => {
    expect(parseIsharesHoldingsCsv(IVV_2018_01_31_HEAD)).toEqual([
      'AAPL', 'MSFT', 'AMZN', 'FB', 'BRKB',
    ]);
  });

  it('parses an IWM-style header and accepts dotted tickers (e.g. BRK.B)', () => {
    expect(parseIsharesHoldingsCsv(IWM_TYPICAL_HEAD)).toEqual([
      'AAON', 'AAT', 'BRK.B',
    ]);
  });

  it('returns an empty array for a no-data preamble (pre-archive / weekend)', () => {
    expect(parseIsharesHoldingsCsv(NO_DATA_PREAMBLE)).toEqual([]);
  });

  it('returns an empty array for an entirely empty input', () => {
    expect(parseIsharesHoldingsCsv('')).toEqual([]);
  });

  it('skips cash sleeves, money-market entries, and malformed tickers', () => {
    expect(parseIsharesHoldingsCsv(NOISY_PREAMBLE_AND_FOOTER)).toEqual([
      'AAA', 'BBB',
    ]);
  });

  it('stops at the first non-quoted row (end-of-holdings sentinel)', () => {
    const csv = `iShares Test ETF
Fund Holdings as of,"Jan 1, 2024"

Ticker,Name,Sector
"AAPL","APPLE","IT"
"MSFT","MICROSOFT","IT"

Disclosure: blah blah
"BAD","SHOULD NOT BE INCLUDED","Equity"
`;
    expect(parseIsharesHoldingsCsv(csv)).toEqual(['AAPL', 'MSFT']);
  });

  it('handles CRLF line endings (Windows-style downloads)', () => {
    const csv = `iShares Test ETF\r\nFund Holdings as of,"Jan 1, 2024"\r\n\r\nTicker,Name,Sector\r\n"AAPL","APPLE","IT"\r\n"MSFT","MICROSOFT","IT"\r\n\r\n`;
    expect(parseIsharesHoldingsCsv(csv)).toEqual(['AAPL', 'MSFT']);
  });

  it('rejects tickers containing spaces or lowercase letters', () => {
    const csv = `iShares Test ETF
Fund Holdings as of,"Jan 1, 2024"

Ticker,Name,Sector
"AAPL","APPLE","IT"
"FOO BAR","BAD","IT"
"abc","BAD","IT"
"XYZ","GOOD","IT"
`;
    expect(parseIsharesHoldingsCsv(csv)).toEqual(['AAPL', 'XYZ']);
  });

  it('rejects tickers longer than 6 characters (probable futures/identifiers)', () => {
    const csv = `iShares Test ETF
Fund Holdings as of,"Jan 1, 2024"

Ticker,Name,Sector
"AAPL","APPLE","IT"
"LONGTICKER","BAD","IT"
"BRK.A","GOOD","Financials"
`;
    expect(parseIsharesHoldingsCsv(csv)).toEqual(['AAPL', 'BRK.A']);
  });

  it('handles common 2018 S&P 500 names (sanity: FB before META rename, BRKB no period)', () => {
    expect(parseIsharesHoldingsCsv(IVV_2018_01_31_HEAD)).toContain('FB');
    expect(parseIsharesHoldingsCsv(IVV_2018_01_31_HEAD)).toContain('BRKB');
    expect(parseIsharesHoldingsCsv(IVV_2018_01_31_HEAD)).not.toContain('META');
  });
});
