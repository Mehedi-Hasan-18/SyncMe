/**
 * Small pure helpers for pairing: token generation, hashing, URL building,
 * device naming, and expiry math. Kept free of browser-only globals (the UA
 * string and URL base are parameters) so they stay unit-testable in Node.
 */

/** 32 random bytes as 64 hex chars — the raw single-use pairing secret. */
export function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex digest. Only the hash is ever stored server-side. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Pairing deep-link carried by the QR code, e.g. `https://x/#​/pair?ws=…&token=…`. */
export function buildPairUrl(base: string, workspaceId: string, rawToken: string): string {
  const cleanBase = base.replace(/\/$/, '');
  return `${cleanBase}#/pair?ws=${encodeURIComponent(workspaceId)}&token=${encodeURIComponent(rawToken)}`;
}

export interface ParsedPairLink {
  workspaceId: string;
  rawToken: string;
}

/** Parses a pairing URL back into its parts; null when malformed. */
export function parsePairUrl(url: string): ParsedPairLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const [path, query] = hash.split('?');
  if (path !== '/pair' || !query) return null;
  const params = new URLSearchParams(query);
  const workspaceId = params.get('ws') ?? '';
  const rawToken = params.get('token') ?? '';
  if (!/^[0-9a-fA-F-]{8,64}$/.test(workspaceId) || !/^[0-9a-fA-F]{32,256}$/.test(rawToken)) {
    return null;
  }
  return { workspaceId, rawToken };
}

/** Friendly default device label derived from a user-agent string. */
export function defaultDeviceName(userAgent = ''): string {
  const ua = userAgent.toLowerCase();
  if (/android/.test(ua)) return 'Android device';
  if (/iphone/.test(ua)) return 'iPhone';
  if (/ipad/.test(ua)) return 'iPad';
  if (/macintosh|mac os/.test(ua)) return 'Mac';
  if (/windows/.test(ua)) return 'Windows PC';
  if (/linux/.test(ua)) return 'Linux PC';
  return 'New device';
}

/** ISO expiry timestamp for a token minted now plus `ttlMinutes`. */
export function tokenExpiryIso(ttlMinutes: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + ttlMinutes * 60_000).toISOString();
}

/** Milliseconds until expiry (<= 0 means expired). */
export function msUntilExpiry(expiresAtIso: string, nowMs: number = Date.now()): number {
  return new Date(expiresAtIso).getTime() - nowMs;
}

/** Formats a countdown as m:ss. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Short id display, e.g. `a1b2c3d4…e5f6`. */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
