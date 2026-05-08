// Firestore restore — for drill testing the backup pipeline.
//
// Reads a backup JSON file and writes every doc back into Firestore.
// Used to verify that backups produced by export-firestore.ts can actually
// round-trip into a fresh project.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=./key.json \
//     npx tsx scripts/restore-firestore.ts ./backups/firestore-2026-05-04.json
//
// Add --dry-run to preview the doc count without writing.

import { promises as fs } from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';
import * as admin from 'firebase-admin';

const gunzip = promisify(zlib.gunzip);

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const inPath = args.find((a) => !a.startsWith('--'));
  if (!inPath) {
    console.error('usage: restore-firestore.ts <backup.json[.gz]> [--dry-run]');
    process.exit(2);
  }

  const raw = await fs.readFile(inPath);
  const buf = inPath.endsWith('.gz') ? await gunzip(raw) : raw;
  const dump = JSON.parse(buf.toString('utf8'));

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();

  let total = 0;
  for (const [coll, docs] of Object.entries(dump.collections ?? {})) {
    if (!Array.isArray(docs)) continue;
    console.log(`${coll}: ${docs.length} docs ${dryRun ? '(dry run, skipping)' : '...'}`);
    if (dryRun) { total += docs.length; continue; }

    // Firestore client supports up to 500 ops per batch.
    let i = 0;
    while (i < docs.length) {
      const batch = db.batch();
      const slice = docs.slice(i, i + 400);
      for (const doc of slice) {
        const { id, ...data } = doc as { id: string; [k: string]: any };
        // Reverse the {__ts:ms} timestamp shape from export.
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && typeof (v as any).__ts === 'number') {
            data[k] = admin.firestore.Timestamp.fromMillis((v as any).__ts);
          }
        }
        batch.set(db.collection(coll).doc(id), data, { merge: true });
      }
      await batch.commit();
      i += slice.length;
    }
    total += docs.length;
  }

  console.log(`restored ${total} docs from ${inPath}`);
}

main().catch((err) => {
  console.error('restore failed:', err);
  process.exit(1);
});
