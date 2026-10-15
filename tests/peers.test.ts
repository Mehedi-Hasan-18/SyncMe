import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetPeerId,
  getOrCreatePeerId,
  loadKnownPeers,
  rememberPeerId,
} from '../src/lib/peer';

/** Node has no DOM storage; install a minimal in-memory stand-in. */
function installMemoryStorage() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installMemoryStorage();
});

describe('known peers (auto-reconnect memory)', () => {
  it('starts empty', () => {
    expect(loadKnownPeers('syncmeself')).toEqual([]);
  });

  it('remembers linked devices most-recent-first without duplicates', () => {
    rememberPeerId('syncmeaaa');
    rememberPeerId('syncmebbb');
    rememberPeerId('syncmeaaa');
    expect(loadKnownPeers('syncmeself')).toEqual(['syncmeaaa', 'syncmebbb']);
  });

  it('forgets explicitly disconnected devices', () => {
    rememberPeerId('syncmeaaa');
    rememberPeerId('syncmebbb');
    forgetPeerId('syncmeaaa');
    expect(loadKnownPeers('syncmeself')).toEqual(['syncmebbb']);
  });

  it('never returns our own id or malformed values', () => {
    rememberPeerId('syncmeself');
    rememberPeerId('not a valid id!!');
    rememberPeerId('');
    rememberPeerId('syncmeok1');
    expect(loadKnownPeers('syncmeself')).toEqual(['syncmeok1']);
  });

  it('generates a stable peer id across calls', () => {
    const first = getOrCreatePeerId();
    expect(first).toMatch(/^syncme[0-9a-f]+$/);
    expect(getOrCreatePeerId()).toBe(first);
  });
});
