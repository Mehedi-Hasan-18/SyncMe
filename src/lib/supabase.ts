import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let client: SupabaseClient | null = null;

/**
 * Returns the shared Supabase client, or null when env is not configured.
 * The client only ever touches metadata tables (workspaces, devices,
 * pairing_tokens) — never shared text or file bytes.
 */
export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  if (!env.supabaseUrl || !env.supabaseKey) return null;
  client = createClient(env.supabaseUrl, env.supabaseKey);
  return client;
}

export interface SessionResult {
  userId: string | null;
  error: string | null;
}

/**
 * Ensures the device holds an anonymous Supabase identity, which is what
 * Row-Level Security policies key workspace isolation off (`auth.uid()`).
 * Requires "Anonymous" sign-in to be enabled in the Supabase dashboard
 * (Authentication → Providers → Anonymous).
 */
export async function ensureAnonymousSession(): Promise<SessionResult> {
  const sb = getSupabase();
  if (!sb) {
    return {
      userId: null,
      error:
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (and in Vercel env vars for deploys).',
    };
  }
  try {
    const { data, error } = await sb.auth.getSession();
    if (error) return { userId: null, error: error.message };
    if (data.session?.user) return { userId: data.session.user.id, error: null };

    const { data: anon, error: signInError } = await sb.auth.signInAnonymously();
    if (signInError) {
      const hint = /anonymous.*(disabled|not enabled|not allowed)/i.test(signInError.message)
        ? ' Enable it in Supabase → Authentication → Providers → Anonymous.'
        : '';
      return { userId: null, error: `Anonymous sign-in failed: ${signInError.message}.${hint}` };
    }
    if (!anon.session?.user) {
      return { userId: null, error: 'Anonymous sign-in returned no session.' };
    }
    return { userId: anon.session.user.id, error: null };
  } catch (err) {
    return {
      userId: null,
      error: err instanceof Error ? err.message : 'Unknown Supabase error.',
    };
  }
}
