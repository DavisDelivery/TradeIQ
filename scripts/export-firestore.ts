// Firestore → JSON backup.
//
// Run by .github/workflows/backup-firestore.yml every Sunday at 06:00 UTC.
// Reads tradeLog (and any future collections listed in COLLECTIONS), writes
// one JSON file per backup run, gzip-compresses if > 1MB.
//
// Auth: expects FIREBASE_SERVICE_ACCOUNT to contain the JSON service-account
// key for project tradeiq-alpha. The CI workflow injects this as a secret
// and writes it to /tmp/firebase-key.json before invoking this script.
//
// Usage (local):
//   GOOGLE_APPLICATION_CREDENTIALS=./key.json npx tsx scripts/export-firestore.ts
//
// Output: backups/firestore-YYYY-MM-DD.json[.gz]

import { promises as fs } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import admin from 'firebase-admin';

const gzip = promisify(zlib.gzip);

// Collections to back up. Add new ones as the schema grows.
const COLLECTIONS = ['tradeLog'] as const;

const COMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024;

async function main() {
  // Init admin SDK. firebase-admin auto-discovers credentials from
  // GOOGLE_APPLICATION_CREDENTIALS or applicationDefault().
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
  const db = admin.firestore();

  const dump: Record<string, any[]> = {};
  let totalDocs = 0;
  for (const coll of COLLECTIONS) {
    process.stdout.write(`exporting ${coll} ... `);
    const snap = await db.collection(coll).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dump[coll] = docs;
    totalDocs += docs.length;
    console.log(`${docs.length} docs`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(process.cwd(), 'backups');
  await fs.mkdir(outDir, { recursive: true });

  const json = JSON.stringify(
    { generatedAt: new Date().toISOString(), totalDocs, collections: dump },
    (_k, v) => {
      // Firestore Timestamp → ISO string for portability.
      if (v && typeof v === 'object' && typeof v._seconds === 'number') {
        return { __ts: v._seconds * 1000 + Math.floor((v._nanoseconds ?? 0) / 1e6) };
      }
      return v;
    },
    2,
  );

  const buf = Buffer.from(json, 'utf8');
  let outPath: string;
  if (buf.byteLength > COMPRESS_THRESHOLD_BYTES) {
    outPath = path.join(outDir, `firestore-${today}.json.gz`);
    await fs.writeFile(outPath, await gzip(buf));
  } else {
    outPath = path.join(outDir, `firestore-${today}.json`);
    await fs.writeFile(outPath, buf);
  }

  console.log(`wrote ${outPath} (${buf.byteLength} uncompressed bytes, ${totalDocs} docs)`);
}

main().catch((err) => {
  console.error('export failed:', err);
  process.exit(1);
});
