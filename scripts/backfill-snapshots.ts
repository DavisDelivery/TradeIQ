#!/usr/bin/env node
/**
 * One-shot backfill: scan the existing tradeLog Firestore collection and
 * synthesize partial snapshots for past (date, board) combinations so
 * HistoryView has something to render for dates that predate Phase 1.
 *
 * What this produces is intentionally thin — trade entries only contain a
 * handful of fields per ticker (whatever was on the card when the user
 * logged it), not the full board state. Each backfilled snapshot represents
 * "tickers the user logged from this board on this UTC date", with whatever
 * scoring/rationale fields the trade entry preserved at log time.
 *
 * RUN ONCE. After Phase 1 ships and scheduled scans start producing real
 * snapshots, this script's output is no longer needed for new dates. Old
 * backfilled snapshots stay in Firestore and continue to render in
 * HistoryView for the dates they cover.
 *
 * Usage:
 *
 *   FIREBASE_SERVICE_ACCOUNT="$(cat ~/path/to/sa.json)" \
 *     npx tsx scripts/backfill-snapshots.ts
 *
 * Or, if `tsx` isn't installed:
 *
 *   FIREBASE_SERVICE_ACCOUNT="$(cat ~/path/to/sa.json)" \
 *     npx --yes -p typescript -p ts-node -p firebase-admin \
 *     ts-node --compiler-options '{"module":"commonjs"}' scripts/backfill-snapshots.ts
 *
 * The script is idempotent — re-running it overwrites any synthesized
 * snapshot for the same (date, board) but does not touch real scheduled-
 * scan snapshots (those have HHmm > 0000 in their IDs).
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const TRADE_LOG_COLLECTION = 'tradeLog';
const SOURCE_TO_BOARD: Record<string, string> = {
  'target-board': 'target-board',
  prophet: 'prophet',
  catalyst: 'catalyst',
  insider: 'insider',
  insiders: 'insider',
  williams: 'williams',
  lynch: 'lynch',
  earnings: 'earnings',
};

// Backfilled snapshots are stamped to ('all','sp500',etc.). Without the actual
// universe at log time, default to 'all' as a catch-all bucket — the user can
// switch boards in HistoryView; per-universe filtering of past trades isn't
// meaningful since trade entries don't carry a universe field.
const BACKFILL_UNIVERSE = 'all';

// Backfilled snapshots use HHmm = '0000' so they sort before any same-day
// real scheduled scan and never collide with one.
const BACKFILL_HHMM = '0000';

interface TradeEntry {
  id: string;
  ticker: string;
  source: string;
  loggedAt: string;
  [key: string]: unknown;
}

function ensureFirebase() {
  if (getApps().length > 0) return;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var not set. Aborting.');
    process.exit(1);
  }
  initializeApp({ credential: cert(JSON.parse(sa)) });
}

function utcDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '1970-01-01';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function main() {
  ensureFirebase();
  const db = getFirestore();

  console.log(`[backfill] reading ${TRADE_LOG_COLLECTION} collection…`);
  const snap = await db.collection(TRADE_LOG_COLLECTION).get();
  console.log(`[backfill] found ${snap.size} trade entries.`);

  // Group by (date, board)
  const groups = new Map<string, TradeEntry[]>();
  for (const doc of snap.docs) {
    const entry = { id: doc.id, ...doc.data() } as TradeEntry;
    if (!entry.loggedAt || !entry.source || !entry.ticker) continue;

    const board = SOURCE_TO_BOARD[entry.source];
    if (!board) continue;

    const date = utcDate(entry.loggedAt);
    const key = `${board}::${date}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  console.log(`[backfill] grouped into ${groups.size} (board, date) buckets.`);

  // Write a synthetic snapshot per group
  let written = 0;
  for (const [key, entries] of groups.entries()) {
    const [board, date] = key.split('::');
    const snapshotId = `${BACKFILL_UNIVERSE}-${date}-${BACKFILL_HHMM}`;
    const generatedAtIso = `${date}T00:00:00.000Z`;

    // Dedupe by ticker (a user may have logged same ticker multiple times)
    const seen = new Set<string>();
    const results = entries
      .filter((e) => {
        if (seen.has(e.ticker)) return false;
        seen.add(e.ticker);
        return true;
      })
      .map((e) => {
        // Strip system fields that aren't part of the original board data
        const {
          id: _id, source: _src, loggedAt: _loggedAt,
          _pendingSync: _ps,
          ...boardFields
        } = e;
        return boardFields;
      });

    const runDoc = db
      .collection('boardSnapshots')
      .doc(board)
      .collection('runs')
      .doc(snapshotId);

    await runDoc.set({
      board,
      universe: BACKFILL_UNIVERSE,
      generatedAt: generatedAtIso,
      writtenAt: Timestamp.now(),
      modelVersion: 'backfill-from-tradelog',
      scanDurationMs: 0,
      universeChecked: results.length,
      results,
      freshnessBudgetMs: 0, // already stale by definition
      warnings: [
        'synthetic snapshot reconstructed from trade journal — fields are limited to what was on the card at log time',
      ],
    });

    written += 1;
    if (written % 25 === 0) {
      console.log(`[backfill] wrote ${written}/${groups.size} snapshots…`);
    }
  }

  console.log(`[backfill] done. ${written} synthetic snapshots written.`);
  console.log('[backfill] HistoryView will show them tagged with model "backfill-from-tradelog".');
  console.log('[backfill] Real scheduled-scan snapshots take precedence on dates that have both.');
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
