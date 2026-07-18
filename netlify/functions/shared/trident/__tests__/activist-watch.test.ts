// TRIDENT 13D watcher — pins the parsing + whitelist + event-assembly
// contract and the partial-feed I-pillar renormalization (design §2).

import { describe, it, expect } from 'vitest';
import {
  parseFormIdx,
  matchActivist,
  assembleEvents,
} from '../activist-watch';
import { scoreInstitutional } from '../scoring';

const IDX_BODY = `Form Type   Company Name                                    CIK         Date Filed  File Name
--------------------------------------------------------------------------------------------------
10-K        SOME OTHER CORP                                 1000001     2026-07-17  edgar/data/1000001/0001000001-26-000001.txt
SC 13D      ACME THERAPEUTICS INC                           1234567     2026-07-17  edgar/data/7654321/0000765432-26-000123.txt
SC 13D      STARBOARD VALUE LP                              7654321     2026-07-17  edgar/data/7654321/0000765432-26-000123.txt
SC 13D/A    WIDGET INDUSTRIES CORP                          2345678     2026-07-17  edgar/data/8888888/0000888888-26-000456.txt
SC 13D/A    ELLIOTT INVESTMENT MANAGEMENT L.P.              8888888     2026-07-17  edgar/data/8888888/0000888888-26-000456.txt
SC 13D      RANDOM FILER NOBODY KNOWS LLC                   3456789     2026-07-17  edgar/data/9999999/0000999999-26-000789.txt
SC 13D      TARGETCO INC                                    4567890     2026-07-17  edgar/data/9999999/0000999999-26-000789.txt
`;

describe('parseFormIdx', () => {
  it('extracts only SC 13D / SC 13D/A rows with normalized fields', () => {
    const rows = parseFormIdx(IDX_BODY);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.formType === 'SC 13D' || r.formType === 'SC 13D/A')).toBe(true);
    expect(rows[0].cik).toBe('0001234567');
    expect(rows[0].dateFiled).toBe('2026-07-17');
  });

  it('handles compact YYYYMMDD dates', () => {
    const rows = parseFormIdx('SC 13D      X CORP        123     20260717    edgar/data/1/acc.txt\n');
    expect(rows[0].dateFiled).toBe('2026-07-17');
  });
});

describe('matchActivist', () => {
  it('matches whitelist names case-insensitively and rejects unknowns', () => {
    expect(matchActivist('STARBOARD VALUE LP')).toBe('Starboard');
    expect(matchActivist('Elliott Investment Management L.P.')).toBe('Elliott');
    expect(matchActivist('ICAHN CARL C')).toBe('Icahn');
    expect(matchActivist('RANDOM FILER NOBODY KNOWS LLC')).toBeNull();
  });
});

describe('assembleEvents', () => {
  it('pairs whitelisted filers with subject tickers; ignores non-whitelisted filings', () => {
    const cikMap = new Map([
      ['0001234567', 'ACME'],
      ['0002345678', 'WIDG'],
      ['0004567890', 'TGT2'],
    ]);
    const events = assembleEvents(parseFormIdx(IDX_BODY), cikMap, '2026-07-18T00:00:00Z');
    expect(events).toHaveLength(2); // Starboard→ACME, Elliott→WIDG; unknown filer's TGT2 dropped
    const acme = events.find((e) => e.ticker === 'ACME')!;
    expect(acme.filer).toBe('Starboard');
    expect(acme.type).toBe('13D');
    const widg = events.find((e) => e.ticker === 'WIDG')!;
    expect(widg.filer).toBe('Elliott');
    expect(widg.type).toBe('13D/A');
    expect(widg.accession).toBe('0000888888-26-000456');
  });
});

describe('scoreInstitutional — W2 partial feed', () => {
  const asOf = '2026-07-18';
  it('conviction unavailable → i2/i3 null, I renormalizes over activist+insider', () => {
    const r = scoreInstitutional({
      activist: { filer: 'Starboard', type: '13D', acceptedAt: '2026-07-10' },
      convictionAdds: [],
      convictionDataAvailable: false,
      clusterCount: 0,
      shortInterestPctFloat: null,
      daysToCover: 2.1,
      instShareOfFloatPct: null,
      breadthDecline: null,
      insiderNetBuyDollars: 500_000,
    }, asOf);
    expect(r.state).toBe('live');
    expect(r.i1).toBe(100);
    expect(r.i2).toBeNull();
    expect(r.i3).toBeNull();
    // Renormalized over i1 (0.4) + i5: I should be dominated by the fresh 13D.
    expect(r.I!).toBeGreaterThan(75);
  });

  it('days-to-cover carries the crowding penalty when %float is unknown', () => {
    const base = {
      activist: { filer: 'X', type: '13D' as const, acceptedAt: '2026-07-10' },
      convictionAdds: [], convictionDataAvailable: false, clusterCount: 0,
      shortInterestPctFloat: null, instShareOfFloatPct: null,
      breadthDecline: null, insiderNetBuyDollars: null,
    };
    const calm = scoreInstitutional({ ...base, daysToCover: 1.5 }, asOf);
    const crowded = scoreInstitutional({ ...base, daysToCover: 10 }, asOf);
    expect(crowded.i4!).toBeGreaterThan(calm.i4!);
    expect(crowded.I!).toBeLessThan(calm.I!);
  });

  it('a no-signal ticker on a CONNECTED feed scores live/low, not warming', () => {
    const r = scoreInstitutional({
      activist: null, convictionAdds: [], convictionDataAvailable: false,
      clusterCount: 0, shortInterestPctFloat: null, daysToCover: 1.0,
      instShareOfFloatPct: null, breadthDecline: null, insiderNetBuyDollars: null,
    }, asOf);
    expect(r.state).toBe('live');
    expect(r.i1).toBe(0); // absence of activist interest IS information now
  });

  it('legacy null input still reports warming', () => {
    const r = scoreInstitutional(null, asOf);
    expect(r.state).toBe('warming');
    expect(r.I).toBeNull();
  });
});
