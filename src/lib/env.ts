/**
 * Centralized environment access.
 *
 * Every external endpoint is env-driven so moving from the free MVP tiers
 * (Supabase free, PeerJS cloud, Open Relay TURN) to paid/self-hosted
 * infrastructure is a config change, not a rewrite.
 *
 * NOTE: every VITE_ value is inlined into client JS at build time and is
 * therefore public. Never put the Supabase service_role key here.
 */

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const env = {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  supabaseUrl: optional(import.meta.env.VITE_SUPABASE_URL),
  /**
   * Supabase anon key. Accepts both the legacy `anon` JWT and the newer
   * `sb_publishable_` format — whichever the dashboard issued.
   */
  supabaseKey: optional(
    import.meta.env.VITE_SUPABASE_ANON_KEY ??
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  ),

  turnUrls: (optional(import.meta.env.VITE_TURN_URLS) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  turnUsername: optional(import.meta.env.VITE_TURN_USERNAME),
  turnCredential: optional(import.meta.env.VITE_TURN_CREDENTIAL),

  peerHost: optional(import.meta.env.VITE_PEER_HOST),
  peerPort: optional(import.meta.env.VITE_PEER_PORT),
  peerKey: optional(import.meta.env.VITE_PEER_KEY),
  peerSecure: optional(import.meta.env.VITE_PEER_SECURE),
};

export function describeMissingEnv(): string[] {
  const missing: string[] = [];
  if (!env.supabaseUrl) missing.push('VITE_SUPABASE_URL');
  if (!env.supabaseKey)
    missing.push('VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY)');
  return missing;
}
