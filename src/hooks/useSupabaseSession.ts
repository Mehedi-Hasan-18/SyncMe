import { useEffect, useState } from 'react';
import { ensureAnonymousSession } from '../lib/supabase';

export type SessionStatus = 'pending' | 'ready' | 'error';

export interface SessionState {
  status: SessionStatus;
  userId: string | null;
  error: string | null;
}

/** Resolves the device's anonymous Supabase identity once on mount. */
export function useSupabaseSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    status: 'pending',
    userId: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    ensureAnonymousSession().then(({ userId, error }) => {
      if (cancelled) return;
      setState(
        error || !userId
          ? { status: 'error', userId: null, error: error ?? 'No session.' }
          : { status: 'ready', userId, error: null },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
