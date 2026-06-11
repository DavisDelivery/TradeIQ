// Phase 6 PR-H — runProphetSnapshot tests.
//
// Pins the brief's two hard rules:
//   1. NO Claude in the scan path. Asserts that narrative-generator's
//      narrateAll / narrateTopN are NEVER imported or invoked during a
//      snapshot scan. (Static import inspection + a dynamic spy on the
//      module's exports.)
//   2. Partial-safe write. When the scan reports budgetExceeded OR the
//      caller passes forcePartial, writeSnapshot is called with
//      status:'partial', and the returned promotedToLatest flag is false.
//      Complete scans write status:'complete' and promote.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories hoist above const declarations, so we use vi.hoisted to
// share spies between the mock factories and the test bodies.
const { writeSnapshotMock, runProphetScanMock, assessPublishMock, narrateAllSpy, narrateTopNSpy, generateNarrativeSpy } = vi.hoisted(() => ({
  writeSnapshotMock: vi.fn(),
  runProphetScanMock: vi.fn(),
  assessPublishMock: vi.fn(),
  narrateAllSpy: vi.fn(),
  narrateTopNSpy: vi.fn(),
  generateNarrativeSpy: vi.fn(),
}));

vi.mock('../snapshot-store', () => ({
  writeSnapshot: writeSnapshotMock,
  assessSnapshotPublish: assessPublishMock,
  FRESHNESS_BUDGETS_MS: { prophet: 1000 },
}));
vi.mock('../scan-prophet', () => ({
  runProphetScan: runProphetScanMock,
}));
// PR-H brief discipline: the scan path must NEVER touch the Claude
// narrator. The spies below assert these stay un-invoked even when the
// runner produces a snapshot. The module isn't imported by
// prophet-snapshot-runner at all (verified by a static-source check
// below); these spies are belt-and-braces.
vi.mock('../narrative-generator', () => ({
  narrateAll: narrateAllSpy,
  narrateTopN: narrateTopNSpy,
  generateNarrative: generateNarrativeSpy,
}));

const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => fakeLogger };

import { runProphetSnapshot } from '../prophet-snapshot-runner';

beforeEach(() => {
  writeSnapshotMock.mockReset();
  runProphetScanMock.mockReset();
  assessPublishMock.mockReset();
  assessPublishMock.mockReturnValue({ action: 'publish' });
  narrateAllSpy.mockReset();
  narrateTopNSpy.mockReset();
  generateNarrativeSpy.mockReset();
});

function fakeScan(overrides: Record<string, unknown> = {}) {
  return {
    picks: [
      { ticker: 'NVDA', composite: 88, conviction: 'high' },
      { ticker: 'AAPL', composite: 64, conviction: 'medium' },
    ],
    scanDurationMs: 120,
    universeChecked: 500,
    warnings: [],
    budgetExceeded: false,
    ...overrides,
  };
}

describe('runProphetSnapshot', () => {
  it('completes successfully and writes status:complete + promotes to _latest', async () => {
    runProphetScanMock.mockResolvedValue(fakeScan());
    writeSnapshotMock.mockResolvedValue({ snapshotId: 'snap-1', promotedToLatest: true });
    const r = await runProphetSnapshot({
      universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('complete');
    expect(r.promotedToLatest).toBe(true);
    expect(r.picks).toBe(2);
    // writeSnapshot received a status:complete snapshot
    expect(writeSnapshotMock).toHaveBeenCalledOnce();
    expect(writeSnapshotMock.mock.calls[0][0]).toBe('prophet');
    expect(writeSnapshotMock.mock.calls[0][1]).toBe('largecap');
    expect(writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'complete' });
  });

  it('writes status:partial when the underlying scan exceeds its budget', async () => {
    runProphetScanMock.mockResolvedValue(fakeScan({ budgetExceeded: true }));
    writeSnapshotMock.mockResolvedValue({ snapshotId: 'snap-2', promotedToLatest: false });
    const r = await runProphetSnapshot({
      universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any,
    });
    expect(r.status).toBe('partial');
    expect(r.promotedToLatest).toBe(false);
    expect(writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'partial' });
  });

  it('honors forcePartial even when the scan completed in budget', async () => {
    runProphetScanMock.mockResolvedValue(fakeScan({ budgetExceeded: false }));
    writeSnapshotMock.mockResolvedValue({ snapshotId: 'snap-3', promotedToLatest: false });
    const r = await runProphetSnapshot({
      universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any, forcePartial: true,
    });
    expect(r.status).toBe('partial');
    expect(writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'partial' });
  });

  it('does NOT invoke any Claude narrator during the scan path', async () => {
    runProphetScanMock.mockResolvedValue(fakeScan());
    writeSnapshotMock.mockResolvedValue({ snapshotId: 'snap-4', promotedToLatest: true });
    await runProphetSnapshot({ universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any });
    expect(narrateAllSpy).not.toHaveBeenCalled();
    expect(narrateTopNSpy).not.toHaveBeenCalled();
    expect(generateNarrativeSpy).not.toHaveBeenCalled();
  });

  it('Wave 2D — demotes a hollow "complete" scan to partial when the publish guard says skip', async () => {
    runProphetScanMock.mockResolvedValue(fakeScan({ picks: [], budgetExceeded: false }));
    assessPublishMock.mockReturnValue({ action: 'skip', reason: 'empty result over 500-ticker universe' });
    writeSnapshotMock.mockResolvedValue({ snapshotId: 'snap-5', promotedToLatest: false });
    const r = await runProphetSnapshot({
      universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any,
    });
    expect(assessPublishMock).toHaveBeenCalledWith({ resultCount: 0, universeChecked: 500 });
    expect(r.status).toBe('partial');
    expect(r.warnings).toContainEqual(expect.stringContaining('publish guard'));
    expect(writeSnapshotMock.mock.calls[0][2]).toMatchObject({ status: 'partial' });
  });

  it('Wave 2D — stamps degraded on a publish-degraded guard decision but still publishes complete', async () => {
    runProphetScanMock.mockResolvedValue(fakeScan());
    assessPublishMock.mockReturnValue({ action: 'publish-degraded', reason: 'degraded: 2/10 calls failed' });
    writeSnapshotMock.mockResolvedValue({ snapshotId: 'snap-6', promotedToLatest: true });
    const r = await runProphetSnapshot({
      universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any,
    });
    expect(r.status).toBe('complete');
    expect(writeSnapshotMock.mock.calls[0][2]).toMatchObject({
      status: 'complete',
      degraded: true,
      degradedReason: 'degraded: 2/10 calls failed',
    });
  });

  it('Wave 2D — does not consult the publish guard for an already-partial scan', async () => {
    runProphetScanMock.mockResolvedValue(fakeScan({ budgetExceeded: true }));
    writeSnapshotMock.mockResolvedValue({ snapshotId: 'snap-7', promotedToLatest: false });
    await runProphetSnapshot({ universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any });
    expect(assessPublishMock).not.toHaveBeenCalled();
  });

  it('returns ok:false on an underlying scan throw without writing a snapshot', async () => {
    runProphetScanMock.mockRejectedValue(new Error('boom'));
    const r = await runProphetSnapshot({
      universe: 'largecap', storeKey: 'largecap', logger: fakeLogger as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
    expect(writeSnapshotMock).not.toHaveBeenCalled();
  });
});

// Static import check: the runner file must not import any Claude module.
// We confirm by reading its source text. The brief's rule is enforced by
// construction; this test makes regressions visible at PR time.
import { readFileSync } from 'node:fs';
describe('prophet-snapshot-runner static guarantees', () => {
  it('does not import the narrative generator / Claude path', () => {
    const src = readFileSync(new URL('../prophet-snapshot-runner.ts', import.meta.url), 'utf-8');
    // Strip comments before checking — the docstring intentionally names
    // the modules to explain WHY they're excluded.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/import[^;]+narrative-generator/);
    expect(code).not.toMatch(/import[^;]+anthropic-client/);
    expect(code).not.toMatch(/import[^;]+anthropic-budget/);
    expect(code).not.toMatch(/callAnthropic/);
  });
});
