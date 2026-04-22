// TradeIQ Firestore Security Rules
// Paste this into Firebase Console → Firestore Database → Rules tab → Publish.
//
// This is "open but time-limited" — any caller can read/write the tradeLog
// collection until a set expiry date. That's fine for a single-user personal
// tool on a private URL, but BEFORE you share the app with anyone else, swap
// to the "authenticated only" version below.

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ─── Development: open until expiry (covers single-user personal use) ───
    // Update the expiry date every few months. After it expires, writes fail
    // and you'll know it's time to either extend or switch to auth.
    match /tradeLog/{tradeId} {
      allow read, write: if request.time < timestamp.date(2026, 10, 1);
    }

    // Everything else: locked down
    match /{document=**} {
      allow read, write: if false;
    }
  }
}

// ─── Production (when adding a second user or going public) ─────────────────
// Replace the tradeLog rule above with this:
//
// match /tradeLog/{tradeId} {
//   allow read, write: if request.auth != null
//     && request.auth.uid == resource.data.ownerUid;
// }
//
// And add ownerUid to every trade entry when logging:
//   logTrade({ ...entry, ownerUid: currentUser.uid })
//
// Plus wire Firebase Auth into src/firebase.js (getAuth, signInWithPopup, etc).
