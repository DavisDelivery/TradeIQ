// Auth facade — Google sign-in over the CDN Firebase loader (src/firebase.js).
// No shared secrets anywhere: trade-queue mutations send the Firebase ID
// token as a Bearer header; the server verifies the token AND that the
// signed-in email is on the OWNER_EMAILS allowlist.

import { fb } from '../firebase.js';

export async function signIn() {
  const { auth } = await fb();
  await auth.signIn();
}

export async function signOutUser() {
  const { auth } = await fb();
  await auth.signOut();
}

/** Current user's email or null. Resolves after first auth state emit. */
export async function currentEmail() {
  const { auth } = await fb();
  const u = auth.currentUser();
  if (u) return u.email ?? null;
  // Wait one auth-state tick — on page load Firebase restores the session
  // asynchronously, so currentUser is briefly null even when signed in.
  return new Promise((resolve) => {
    const un = auth.onChange((user) => {
      un();
      resolve(user?.email ?? null);
    });
  });
}

/** Fresh ID token for Authorization: Bearer, or null when signed out. */
export async function getIdToken() {
  try {
    const { auth } = await fb();
    const u = auth.currentUser();
    if (u) return await auth.getIdToken();
    // Same restore-race guard as currentEmail.
    return await new Promise((resolve) => {
      const un = auth.onChange(async (user) => {
        un();
        resolve(user ? await auth.getIdToken() : null);
      });
    });
  } catch {
    return null;
  }
}

/** Subscribe to auth changes; returns unsubscribe. */
export function onAuthChange(cb) {
  let un = () => {};
  fb().then(({ auth }) => { un = auth.onChange(cb); }).catch(() => cb(null));
  return () => un();
}
