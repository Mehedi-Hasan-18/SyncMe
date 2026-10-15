import * as Y from 'yjs';

/**
 * Minimal Yjs document-sync protocol spoken over a PeerJS DataConnection.
 *
 * - On open, each side sends `sync-step1` (its state vector).
 * - The receiver answers `sync-step2` (the diff the other side is missing).
 * - Every local edit afterwards is broadcast as `doc-update`.
 *
 * Because Yjs is a CRDT, concurrent edits on two devices converge
 * automatically — simultaneous typing never silently overwrites.
 *
 * Payloads are base64 inside plain JSON objects so the protocol survives
 * any PeerJS `serialization` mode ('json' or 'binary').
 */

export type SyncMessage =
  | { kind: 'sync-step1'; sv: string }
  | { kind: 'sync-step2'; update: string }
  | { kind: 'doc-update'; update: string };

/** Origin tag used when applying remote updates so they are never rebroadcast. */
export const REMOTE_ORIGIN = 'remote';

export function u8ToB64(u8: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function isB64String(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 10_000_000 && /^[A-Za-z0-9+/=]*$/.test(value);
}

/**
 * Validates an arbitrary inbound payload. Returns null for anything that
 * is not a well-formed protocol message, so malformed data can never reach
 * the Yjs document.
 */
export function normalizeMessage(raw: unknown): SyncMessage | null {
  if (typeof raw === 'string') {
    try {
      return normalizeMessage(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (msg.kind === 'sync-step1' && isB64String(msg.sv)) {
    return { kind: 'sync-step1', sv: msg.sv };
  }
  if ((msg.kind === 'sync-step2' || msg.kind === 'doc-update') && isB64String(msg.update)) {
    return { kind: msg.kind, update: msg.update };
  }
  return null;
}

export interface IncomingResult {
  /** Reply to send back over the same connection, if any. */
  reply: SyncMessage | null;
  /** True when the shared document actually changed. */
  updated: boolean;
}

export interface SyncChannel {
  text: Y.Text;
  /** Message to send when a connection opens (our state vector). */
  initialMessage: () => SyncMessage;
  /** Broadcast wrapper for a raw local Yjs update. */
  createDocUpdate: (update: Uint8Array) => SyncMessage;
  /** Applies one validated inbound message; never throws on bad payloads. */
  handleIncoming: (msg: SyncMessage) => IncomingResult;
}

export function createSyncChannel(doc: Y.Doc): SyncChannel {
  const text = doc.getText('shared');

  return {
    text,
    initialMessage: () => ({ kind: 'sync-step1', sv: u8ToB64(Y.encodeStateVector(doc)) }),
    createDocUpdate: (update: Uint8Array) => ({ kind: 'doc-update', update: u8ToB64(update) }),
    handleIncoming: (msg: SyncMessage): IncomingResult => {
      try {
        if (msg.kind === 'sync-step1') {
          const diff = Y.encodeStateAsUpdate(doc, b64ToU8(msg.sv));
          return { reply: { kind: 'sync-step2', update: u8ToB64(diff) }, updated: false };
        }
        Y.applyUpdate(doc, b64ToU8(msg.update), REMOTE_ORIGIN);
        return { reply: null, updated: true };
      } catch {
        return { reply: null, updated: false };
      }
    },
  };
}

/**
 * Applies a textarea value to the shared Y.Text using a common
 * prefix/suffix diff, so local keystrokes become minimal insert/delete
 * operations instead of a full replace. This preserves concurrent remote
 * inserts that a naive "delete all + insert" would destroy.
 */
export function applyLocalEdit(text: Y.Text, next: string): void {
  const doc = text.doc;
  if (!doc) return;
  doc.transact(() => {
    const cur = text.toString();
    if (cur === next) return;
    let start = 0;
    while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
    let endCur = cur.length;
    let endNext = next.length;
    while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
      endCur--;
      endNext--;
    }
    if (start < endCur) text.delete(start, endCur - start);
    if (start < endNext) text.insert(start, next.slice(start, endNext));
  });
}
