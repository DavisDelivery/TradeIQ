// Firebase singleton for TradeIQ.
// Lazy-loads the Firebase SDK from CDN the first time any function is called.
// No build-time dependency on the `firebase` npm package — keeps the bundle small
// and avoids version-lock issues.

const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'tradeiq-alpha.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'tradeiq-alpha',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'tradeiq-alpha.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '101124117025',
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const FB_VERSION = '10.12.2';

let _readyPromise = null;

function loadFirebase() {
  if (_readyPromise) return _readyPromise;
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Firebase only runs in browser'));
  }
  if (window._fbTradeiq) return Promise.resolve(window._fbTradeiq);

  _readyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.textContent = `
      import { initializeApp } from "https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-app.js";
      import {
        getFirestore, doc, setDoc, getDoc, deleteDoc,
        collection, getDocs, onSnapshot, query, orderBy, limit, where,
        serverTimestamp
      } from "https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-firestore.js";

      try {
        const app = initializeApp(${JSON.stringify(FIREBASE_CONFIG)});
        const db = getFirestore(app);
        window._fbTradeiq = {
          db,
          ops: {
            write: async (path, data) => {
              await setDoc(doc(db, ...path.split('/')), data, { merge: true });
              return true;
            },
            read: async (path) => {
              const snap = await getDoc(doc(db, ...path.split('/')));
              return snap.exists() ? snap.data() : null;
            },
            remove: async (path) => {
              await deleteDoc(doc(db, ...path.split('/')));
              return true;
            },
            listAll: async (collectionPath, opts = {}) => {
              let q = collection(db, ...collectionPath.split('/'));
              if (opts.orderByField) {
                q = query(q, orderBy(opts.orderByField, opts.direction || 'desc'));
              }
              if (opts.limitTo) {
                q = query(q, limit(opts.limitTo));
              }
              const snap = await getDocs(q);
              return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            },
            subscribe: (collectionPath, cb, opts = {}) => {
              let q = collection(db, ...collectionPath.split('/'));
              if (opts.orderByField) {
                q = query(q, orderBy(opts.orderByField, opts.direction || 'desc'));
              }
              return onSnapshot(q, (snap) => {
                cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
              }, (err) => {
                console.error('[firebase] subscribe error', err);
              });
            },
            serverTimestamp,
          }
        };
        window.dispatchEvent(new Event('_fbTradeiqReady'));
      } catch (err) {
        window.dispatchEvent(new CustomEvent('_fbTradeiqError', { detail: err.message }));
      }
    `;
    document.head.appendChild(script);

    window.addEventListener('_fbTradeiqReady', () => resolve(window._fbTradeiq), { once: true });
    window.addEventListener('_fbTradeiqError', (ev) => reject(new Error(ev.detail)), { once: true });
    setTimeout(() => reject(new Error('Firebase load timeout after 15s')), 15000);
  });

  return _readyPromise;
}

export async function fb() {
  return loadFirebase();
}

// Convenience: returns { ops } or null if Firebase is unavailable.
// Callers should treat null as "offline mode — use localStorage fallback".
export async function fbOps() {
  try {
    const { ops } = await loadFirebase();
    return ops;
  } catch (err) {
    console.warn('[firebase] unavailable, falling back to local:', err.message);
    return null;
  }
}

// For UI components that want to show connection state.
export function isFbReady() {
  return typeof window !== 'undefined' && !!window._fbTradeiq;
}
