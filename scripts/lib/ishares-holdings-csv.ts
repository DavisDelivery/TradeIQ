// scripts/lib/ishares-holdings-csv.ts
//
// Pure parser for iShares fund-holdings CSV. The layout is identical
// across funds (IWM Russell 2000, IVV S&P 500, etc.): a fund-metadata
// preamble of ~10 lines followed by a `Ticker,Name,Sector,...` header
// row and quoted data rows. iShares serves the file via
// `?fileType=csv&dataType=fund[&asOfDate=YYYYMMDD]`. Pre-archive dates
// and weekend probes return the preamble with no header row, which this
// parser surfaces as an empty array — callers should treat that as "no
// data for this date" and probe an adjacent trading day.

export function parseIsharesHoldingsCsv(csv: string): string[] {
  const lines = csv.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (lines[i].startsWith('Ticker,Name,')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    // No-data wrapper (pre-archive date or non-trading day).
    return [];
  }
  const tickers: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.startsWith('"')) break;       // end of holdings block
    const m = line.match(/^"([^"]*)"/);
    if (!m) continue;
    const t = m[1].trim();
    if (!t || t === '-') continue;
    if (/[^A-Z0-9.\-]/.test(t)) continue;             // skip cash sleeves etc
    if (t.length > 6) continue;                        // not a plain US equity ticker
    tickers.push(t);
  }
  return tickers;
}
