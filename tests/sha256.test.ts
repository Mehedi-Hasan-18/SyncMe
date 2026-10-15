import { describe, expect, it } from 'vitest';
import { sha256Bytes, sha256HexFallback } from '../src/lib/sha256';
import { sha256Hex } from '../src/lib/device';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('pure-JS SHA-256 fallback', () => {
  it('matches the official test vectors', () => {
    // Empty string (single padded block).
    expect(sha256HexFallback('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // 'abc' (single block).
    expect(sha256HexFallback('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // 56-byte message (pads into two blocks — exercises the padding edge).
    expect(sha256HexFallback('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with Web Crypto on token-shaped input', async () => {
    const token =
      '9f2c4a7d1e5b8f3a6c9d2e5f8a1b4c7d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a3b';
    expect(sha256HexFallback(token)).toBe(await sha256Hex(token));
    expect(sha256Bytes(new TextEncoder().encode(token))).toHaveLength(32);
    expect(hex(sha256Bytes(new Uint8Array(0)))).toBe(sha256HexFallback(''));
  });
});
