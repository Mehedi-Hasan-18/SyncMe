import { describe, expect, it } from 'vitest';
import {
  buildPairUrl,
  defaultDeviceName,
  formatCountdown,
  msUntilExpiry,
  parsePairUrl,
  randomHex,
  sha256Hex,
  shortId,
  tokenExpiryIso,
} from '../src/lib/device';

describe('pairing helpers', () => {
  it('generates 64-char hex tokens', () => {
    const raw = randomHex(32);
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex(32)).not.toBe(raw);
  });

  it('hashes with SHA-256 (known vector)', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const h1 = await sha256Hex(randomHex());
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips the pairing URL through parse', () => {
    const wsId = '123e4567-e89b-12d3-a456-426614174000';
    const url = buildPairUrl('https://syncme.vercel.app/', wsId, 'a'.repeat(64));
    expect(url).toBe('https://syncme.vercel.app#/pair?ws=' + wsId + '&token=' + 'a'.repeat(64));
    expect(parsePairUrl(url)).toEqual({ workspaceId: wsId, rawToken: 'a'.repeat(64) });
  });

  it('rejects malformed pairing URLs', () => {
    expect(parsePairUrl('https://x/')).toBeNull();
    expect(parsePairUrl('https://x#/pair')).toBeNull();
    expect(parsePairUrl('https://x#/pair?ws=&token=abc')).toBeNull();
    expect(parsePairUrl('https://x#/pair?ws=w&token=!!!')).toBeNull();
    expect(parsePairUrl('not a url')).toBeNull();
    expect(parsePairUrl('https://x#/other?ws=w&token=' + 'a'.repeat(64))).toBeNull();
  });

  it('names devices from the user agent', () => {
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 14)')).toBe('Android device');
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('iPhone');
    expect(defaultDeviceName('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('iPad');
    expect(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('Mac');
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows PC');
    expect(defaultDeviceName('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux PC');
    expect(defaultDeviceName('')).toBe('New device');
  });

  it('computes a 5-minute expiry and countdown', () => {
    const now = 1_700_000_000_000;
    const expiresAt = tokenExpiryIso(5, now);
    expect(new Date(expiresAt).getTime() - now).toBe(5 * 60_000);
    expect(msUntilExpiry(expiresAt, now)).toBe(5 * 60_000);
    expect(msUntilExpiry(expiresAt, now + 5 * 60_000 + 1)).toBeLessThanOrEqual(0);
    expect(formatCountdown(5 * 60_000)).toBe('5:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('shortens long ids for display', () => {
    expect(shortId('abcdefghijklmnop')).toBe('abcdefgh…mnop');
    expect(shortId('short')).toBe('short');
  });
});
