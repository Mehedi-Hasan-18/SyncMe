import { bytesToHex, sha256Bytes } from './sha256';
import { randomHex } from './device';

/**
 * QuickDrop wire format + validation.
 *
 * Control messages ride the existing JSON sync channel as extension payloads
 * (`{ kind: 'ext', channel: 'syncme-file', … }`). File bytes ride a dedicated
 * binary DataConnection (label `syncme-file`) as framed ArrayBuffers:
 *
 *   [u8 type=0x01][16B transfer id][u32be chunk index][…payload ≤ 16KB]
 *
 * Nothing here touches any server: hashes are computed on-device, chunks go
 * peer-to-peer, and received files live in memory Blobs until the user saves.
 */

export const FILE_CHANNEL = 'syncme-file';
export const CHUNK_SIZE = 16 * 1024;
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_FILE_SIZE_LABEL = '100 MB';
export const MAX_FILES_PER_BATCH = 5;
export const MAX_BUFFERED = 512 * 1024;
export const TRANSFER_TIMEOUT_MS = 30_000;
export const MAX_INBOX_ENTRIES = 50;

const FRAME_CHUNK = 0x01;
const HEADER_LEN = 1 + 16 + 4;

/** Executables get a caution label (never blocked — they're your own files). */
const EXECUTABLE_RE = /\.(exe|msi|apk|app|dmg|pkg|sh|bat|cmd|ps1|scr|com|jar)$/i;

export function randomTransferId(): string {
  return randomHex(16);
}

export function isRiskyFileName(name: string): boolean {
  return EXECUTABLE_RE.test(name);
}

/** Strips directory components and caps length for safe display/saving. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.trim().slice(0, 255);
  return clean || 'file';
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function encodeChunk(transferIdHex: string, index: number, payload: ArrayBuffer): ArrayBuffer {
  const id = hexToBytes(transferIdHex);
  if (!id || id.length !== 16) throw new Error('Bad transfer id.');
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error('Bad chunk index.');
  }
  const frame = new ArrayBuffer(HEADER_LEN + payload.byteLength);
  const view = new DataView(frame);
  view.setUint8(0, FRAME_CHUNK);
  new Uint8Array(frame, 1, 16).set(id);
  view.setUint32(17, index);
  new Uint8Array(frame, HEADER_LEN).set(new Uint8Array(payload));
  return frame;
}

export interface DecodedChunk {
  id: string;
  index: number;
  payload: ArrayBuffer;
}

/** Returns null for anything that is not a well-formed chunk frame. */
export function decodeChunk(raw: unknown): DecodedChunk | null {
  if (!(raw instanceof ArrayBuffer)) return null;
  if (raw.byteLength < HEADER_LEN) return null;
  const view = new DataView(raw);
  if (view.getUint8(0) !== FRAME_CHUNK) return null;
  return {
    id: bytesToHex(new Uint8Array(raw, 1, 16)),
    index: view.getUint32(17),
    payload: raw.slice(HEADER_LEN),
  };
}

// Control messages ------------------------------------------------------------------

export type FileControl =
  | { type: 'file-offer'; id: string; name: string; size: number; mime: string; sha256: string }
  | { type: 'file-end'; id: string; sha256: string }
  | { type: 'file-cancel'; id: string };

const ID_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict validation for inbound file-control payloads. Null = drop it. */
export function normalizeFileControl(raw: unknown): FileControl | null {
  if (!isRecord(raw)) return null;
  const { type, id } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (type === 'file-cancel') return { type, id };
  if (type === 'file-end') {
    if (typeof raw.sha256 !== 'string' || !HASH_RE.test(raw.sha256)) return null;
    return { type, id, sha256: raw.sha256.toLowerCase() };
  }
  if (type === 'file-offer') {
    if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 255) return null;
    if (!Number.isInteger(raw.size) || (raw.size as number) < 0 || (raw.size as number) > MAX_FILE_SIZE) {
      return null;
    }
    if (typeof raw.mime !== 'string' || raw.mime.length > 128) return null;
    if (typeof raw.sha256 !== 'string' || !HASH_RE.test(raw.sha256)) return null;
    return {
      type,
      id,
      name: sanitizeFileName(raw.name),
      size: raw.size as number,
      mime: raw.mime || 'application/octet-stream',
      sha256: raw.sha256.toLowerCase(),
    };
  }
  return null;
}

// Validation + hashing -----------------------------------------------------------------

export interface RejectedFile {
  name: string;
  reason: string;
}

export interface AcceptedFile {
  file: File;
  risky: boolean;
}

export function validateOutgoing(files: File[]): { accepted: AcceptedFile[]; rejected: RejectedFile[] } {
  const accepted: AcceptedFile[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files.slice(0, MAX_FILES_PER_BATCH)) {
    if (file.size > MAX_FILE_SIZE) {
      rejected.push({ name: file.name, reason: `Exceeds the ${MAX_FILE_SIZE_LABEL} limit.` });
    } else {
      accepted.push({ file, risky: isRiskyFileName(file.name) });
    }
  }
  for (const file of files.slice(MAX_FILES_PER_BATCH)) {
    rejected.push({ name: file.name, reason: `Only ${MAX_FILES_PER_BATCH} files per batch.` });
  }
  return { accepted, rejected };
}

/** SHA-256 of a Blob (Web Crypto with the pure-JS fallback for http-LAN). */
export async function sha256HexOfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', buf);
      return bytesToHex(new Uint8Array(digest));
    }
  } catch {
    // Fall through to the pure-JS implementation.
  }
  return bytesToHex(sha256Bytes(new Uint8Array(buf)));
}

export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.round((done / total) * 100));
}
