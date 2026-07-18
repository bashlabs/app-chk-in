import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

import { auth, db } from '../firebase';
import { COLLECTIONS } from '../../shared/collections.js';

export type AuthState = {
  user: User | null;
  /** Mirrors the Firestore rules: an admin is anyone with a doc in COLLECTIONS.admins. */
  isAdmin: boolean;
  loading: boolean;
  /**
   * Set when the admin check couldn't run at all, as opposed to running and
   * finding no admin doc. 'permission-denied' almost always means the Firestore
   * rules that grant a user the read of their *own* admin doc aren't deployed —
   * a setup problem, not "you're not an admin". Kept distinct so the UI can say
   * so instead of wrongly turning a real admin away.
   */
  checkError: 'permission-denied' | 'unavailable' | null;
};

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAdmin: false,
    loading: true,
    checkError: null,
  });

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setState({ user: null, isAdmin: false, loading: false, checkError: null });
        return;
      }

      try {
        const isAdmin = (await getDoc(doc(db, COLLECTIONS.admins, user.uid))).exists();
        setState({ user, isAdmin, loading: false, checkError: null });
      } catch (err) {
        // Our rules *allow* any signed-in user to read their own admin doc, so
        // a denial here means those rules aren't live — surface it rather than
        // silently reporting "not an admin".
        const code = (err as { code?: string })?.code;
        const checkError = code === 'permission-denied' ? 'permission-denied' : 'unavailable';
        setState({ user, isAdmin: false, loading: false, checkError });
      }
    });
  }, []);

  return state;
}
