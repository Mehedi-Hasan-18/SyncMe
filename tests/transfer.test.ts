import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  decodeChunk,
  encodeChunk,
  hexToBytes,
  isRiskyFileName,
  normalizeFileControl,
  progressPercent,
  randomTransferId,
  sanitizeFileName,
  sha256HexOfBlob,
  validateOutgoing,
} from '../src/lib/transfer';
import { bytesToHex } from '../src/lib/sha256';

const ID = 'a'.repeat(32);
const HASH = 'b'.repeat(64);

function makeFile(name: string, size: number, type = 'text/plain'): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  return new File([bytes], name, { type });
}

describe('chunk framing', () => {
  it('round-trips a chunk frame', () => {
    const payload = new Uint8Array([1, 2, 3, 250]).buffer;
    const frame = encodeChunk(ID, 42, payload);
    expect(frame.byteLength).toBe(1 + 16 + 4 + 4);
    const decoded = decodeChunk(frame);
    expect(decoded?.id).toBe(ID);
    expect(decoded?.index).toBe(42);
    expect(new Uint8Array(decoded?.payload ?? [])).toEqual(new Uint8Array([1, 2, 3, 250]));
  });

  it('handles chunk index boundaries', () => {
    const payload = new Uint8Array(0).buffer;
    expect(decodeChunk(encodeChunk(ID, 0, payload))?.index).toBe(0);
    expect(decodeChunk(encodeChunk(ID, 0xffffffff, payload))?.index).toBe(0xffffffff);
  });

  it('rejects malformed frames', () => {
    expect(decodeChunk(null)).toBeNull();
    expect(decodeChunk('nope')).toBeNull();
    expect(decodeChunk(new ArrayBuffer(5))).toBeNull();
    const wrongType = new ArrayBuffer(21 + 3);
    new DataView(wrongType).setUint8(0, 0x02);
    expect(decodeChunk(wrongType)).toBeNull();
    expect(() => encodeChunk('short', 0, new ArrayBuffer(1))).toThrow();
    expect(() => encodeChunk(ID, -1, new ArrayBuffer(1))).toThrow();
  });

  it('generates unique 32-hex-char transfer ids', () => {
    expect(randomTransferId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomTransferId()).not.toBe(randomTransferId());
  });
});

describe('control validation', () => {
  it('accepts well-formed control messages', () => {
    expect(
      normalizeFileControl({ type: 'file-offer', id: ID, name: 'a.pdf', size: 10, mime: 'application/pdf', sha256: HASH }),
    ).toEqual({ type: 'file-offer', id: ID, name: 'a.pdf', size: 10, mime: 'application/pdf', sha256: HASH });
    expect(normalizeFileControl({ type: 'file-end', id: ID, sha256: HASH })).toEqual({
      type: 'file-end',
      id: ID,
      sha256: HASH,
    });
    expect(normalizeFileControl({ type: 'file-received', id: ID, ok: true })).toEqual({
      type: 'file-received',
      id: ID,
      ok: true,
      error: undefined,
    });
    expect(normalizeFileControl({ type: 'file-cancel', id: ID })).toEqual({ type: 'file-cancel', id: ID });
  });

  it('rejects malformed control messages', () => {
    expect(normalizeFileControl(null)).toBeNull();
    expect(normalizeFileControl({ type: 'file-offer', id: 'x', name: 'a', size: 1, mime: 't', sha256: HASH })).toBeNull();
    expect(normalizeFileControl({ type: 'file-offer', id: ID, name: '', size: 1, mime: 't', sha256: HASH })).toBeNull();
    expect(normalizeFileControl({ type: 'file-offer', id: ID, name: 'a', size: -1, mime: 't', sha256: HASH })).toBeNull();
    expect(
      normalizeFileControl({ type: 'file-offer', id: ID, name: 'a', size: MAX_FILE_SIZE + 1, mime: 't', sha256: HASH }),
    ).toBeNull();
    expect(normalizeFileControl({ type: 'file-offer', id: ID, name: 'a', size: 1, mime: 't', sha256: 'zzz' })).toBeNull();
    expect(normalizeFileControl({ type: 'file-end', id: ID, sha256: 'short' })).toBeNull();
    expect(normalizeFileControl({ type: 'file-received', id: ID, ok: 'yes' })).toBeNull();
    expect(normalizeFileControl({ type: 'nope', id: ID })).toBeNull();
    expect(normalizeFileControl({ kind: 'doc-update', update: 'eA==' })).toBeNull();
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\x.txt')).toBe('x.txt');
    expect(sanitizeFileName('   ')).toBe('file');
  });
});

describe('validation + hashing', () => {
  it('enforces the size cap and batch limit', () => {
    const big = makeFile('big.bin', MAX_FILE_SIZE + 1, 'application/octet-stream');
    const ok = makeFile('ok.txt', 10);
    const { accepted, rejected } = validateOutgoing([ok, big]);
    expect(accepted.map((a) => a.file.name)).toEqual(['ok.txt']);
    expect(rejected.map((r) => r.name)).toEqual(['big.bin']);

    const many = Array.from({ length: 7 }, (_, i) => makeFile(`f${i}.txt`, 5));
    const capped = validateOutgoing(many);
    expect(capped.accepted).toHaveLength(5);
    expect(capped.rejected).toHaveLength(2);
  });

  it('flags executables without blocking them', () => {
    expect(isRiskyFileName('setup.exe')).toBe(true);
    expect(isRiskyFileName('app.apk')).toBe(true);
    expect(isRiskyFileName('run.sh')).toBe(true);
    expect(isRiskyFileName('photo.png')).toBe(false);
    expect(isRiskyFileName('notes.txt')).toBe(false);
    const { accepted } = validateOutgoing([makeFile('setup.exe', 10, 'application/octet-stream')]);
    expect(accepted[0]?.risky).toBe(true);
  });

  it('hashes blobs identically to the byte-level implementation', async () => {
    const file = makeFile('hello.txt', 1000);
    const expected = bytesToHex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
    );
    expect(await sha256HexOfBlob(file)).toBe(expected);
    expect(await sha256HexOfBlob(new Blob([]))).toHaveLength(64);
  });

  it('computes progress safely', () => {
    expect(progressPercent(0, 0)).toBe(100);
    expect(progressPercent(50, 100)).toBe(50);
    expect(progressPercent(200, 100)).toBe(100);
  });

  it('converts hex strictly', () => {
    expect(hexToBytes('00ff')).toEqual(new Uint8Array([0, 255]));
    expect(hexToBytes('zz')).toBeNull();
    expect(hexToBytes('abc')).toBeNull();
    expect(CHUNK_SIZE).toBe(16384);
  });
});
