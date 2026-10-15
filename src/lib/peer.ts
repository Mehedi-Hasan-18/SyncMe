import { Peer } from 'peerjs';
import { env } from './env';

export type PeerOptions = ConstructorParameters<typeof Peer>[1];

const PEER_ID_STORAGE_KEY = 'syncme-peer-id';

/**
 * Returns a stable, alphanumeric peer id for this device, generating and
 * persisting one on first use. Alphanumeric-only keeps the free PeerJS
 * cloud happy, and stability across reloads makes re-pairing painless.
 */
export function getOrCreatePeerId(): string {
  try {
    const existing = localStorage.getItem(PEER_ID_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9]+$/.test(existing)) return existing;
  } catch {
    // Storage unavailable (private mode) — fall through to an ephemeral id.
  }
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const id = `syncme${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  try {
    localStorage.setItem(PEER_ID_STORAGE_KEY, id);
  } catch {
    // Non-fatal: the id just won't survive a reload.
  }
  return id;
}

/** ICE servers: always Google STUN, plus the configured (free) TURN fallback. */
export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (env.turnUrls.length > 0) {
    const turn: RTCIceServer = { urls: env.turnUrls };
    if (env.turnUsername) turn.username = env.turnUsername;
    if (env.turnCredential) turn.credential = env.turnCredential;
    servers.push(turn);
  }
  return servers;
}

/**
 * Creates a PeerJS peer. With no VITE_PEER_* overrides this uses the free
 * PeerJS cloud for signaling; set the overrides to point at a self-hosted
 * `peer` server later with no code changes.
 */
export function createPeer(stableId: string): Peer {
  const options: PeerOptions = {
    config: { iceServers: getIceServers() },
  };
  if (env.peerHost) {
    options.host = env.peerHost;
    if (env.peerPort) {
      const port = Number(env.peerPort);
      if (Number.isFinite(port)) options.port = port;
    }
    if (env.peerKey) options.key = env.peerKey;
    if (env.peerSecure !== undefined) {
      options.secure = env.peerSecure === '1' || env.peerSecure.toLowerCase() === 'true';
    }
  }
  return new Peer(stableId, options);
}

/** True when signaling goes to a self-hosted server instead of PeerJS cloud. */
export function isSelfHostedSignaling(): boolean {
  return Boolean(env.peerHost);
}
