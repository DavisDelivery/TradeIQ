# Firestore Indexes Runbook

## Why this file exists

Firestore composite indexes are required for any query combining `where` + `orderBy` on different fields, or multiple `where` clauses against different fields. When a query needs a composite index that doesn't exist, Firestore throws `FAILED_PRECONDITION` and the request 500s.

Until 2026-05-11 we were creating indexes ad-hoc through the Firebase Console after Sentry alerts. That's reactive, invisible in code review, and easy to forget on deploy. This repo now version-controls all required indexes in `firestore.indexes.json`.

## When to update

Anytime you add a Firestore query that combines:

- `.where(field1, ...).orderBy(field2, ...)` — needs `[field1, field2]` composite
- `.where(field1, ...).where(field2, range_op).orderBy(field2, ...)` — same shape
- `.where(field1, ...).where(field2, ...)` with both filters non-equality — composite required
- Collection-group queries that filter by anything other than `__name__`

A safe rule: every time `npm run build` succeeds but a query throws in production with a "create an index" URL, that's a missed index update to this file.

## How to deploy

After editing `firestore.indexes.json`, deploy via Firebase CLI from your local machine:

```bash
# One-time setup
npm install -g firebase-tools
firebase login

# Deploy indexes only (does not touch security rules or any other firebase config)
firebase deploy --only firestore:indexes --project tradeiq-alpha
```

Index builds take 1–5 minutes for small collections, longer for large ones. The CLI streams progress.

To deploy from a CI environment (no interactive login), use a service account:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
firebase deploy --only firestore:indexes --project tradeiq-alpha --non-interactive
```

The existing `FIREBASE_SERVICE_ACCOUNT` env var on Netlify and in GitHub Actions secrets works for this purpose.

## Optional: GitHub Action to auto-deploy on push to main

A workflow template is at `docs/FIREBASE_INDEXES_WORKFLOW.md.template.yml`. Install it manually via the GitHub UI (the build PAT can't push to `.github/workflows/` — same pattern as the CI and backup workflows). Once installed, any change to `firestore.indexes.json` on main triggers an automatic deploy.

## Current indexes

| Collection group | Fields | Used by |
|---|---|---|
| `runs` | `universe` ASC, `generatedAt` DESC | `listSnapshots`, `snapshotBeforeDate`, `fieldAtDate` in `netlify/functions/shared/snapshot-store.ts` |

## When indexes can be removed

If a query that needed an index is removed from the code, the index can be removed from `firestore.indexes.json` to save Firestore storage. The cost is small — leave them unless storage becomes a concern. Removing an index is destructive: re-adding it requires another build cycle.
