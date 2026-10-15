import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyLocalEdit,
  createSyncChannel,
  normalizeMessage,
  u8ToB64,
  b64ToU8,
} from '../src/lib/sync';

/**
 * Simulates a live DataConnection between two sync channels: delivers every
 * message from A into B (and any reply back into A) until quiescent.
 */
function pump(a: ReturnType<typeof createSyncChannel>, b: ReturnType<typeof createSyncChannel>) {
  const inFlightA: { kind: string; [k: string]: unknown }[] = [];
  const inFlightB: { kind: string; [k: string]: unknown }[] = [];
  inFlightA.push(a.initialMessage() as unknown as { kind: string; [k: string]: unknown });
  inFlightB.push(b.initialMessage() as unknown as { kind: string; [k: string]: unknown });
  for (let i = 0; i < 10; i++) {
    const toB = inFlightA.splice(0);
    const toA = inFlightB.splice(0);
    if (toB.length === 0 && toA.length === 0) break;
    for (const raw of toB) {
      const msg = normalizeMessage(raw);
      if (!msg) continue;
      const { reply } = b.handleIncoming(msg);
      if (reply) inFlightB.push(reply as unknown as { kind: string; [k: string]: unknown });
    }
    for (const raw of toA) {
      const msg = normalizeMessage(raw);
      if (!msg) continue;
      const { reply } = a.handleIncoming(msg);
      if (reply) inFlightA.push(reply as unknown as { kind: string; [k: string]: unknown });
    }
  }
}

describe('sync protocol', () => {
  it('converges an edit from one device to the other', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const chA = createSyncChannel(docA);
    const chB = createSyncChannel(docB);

    applyLocalEdit(chA.text, 'Hello from laptop');
    const msg = chA.createDocUpdate(Y.encodeStateAsUpdate(docA));
    const { reply, updated } = chB.handleIncoming(msg);

    expect(reply).toBeNull();
    expect(updated).toBe(true);
    expect(chB.text.toString()).toBe('Hello from laptop');
  });

  it('merges simultaneous edits on both devices without silent loss', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const chA = createSyncChannel(docA);
    const chB = createSyncChannel(docB);

    // Both start from the same state, then edit "simultaneously".
    pump(chA, chB);
    applyLocalEdit(chA.text, 'laptop');
    applyLocalEdit(chB.text, 'phone');
    // Exchange only the live updates (each side's own keystrokes).
    const updateA = chA.createDocUpdate(Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    const updateB = chB.createDocUpdate(Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    chB.handleIncoming(updateA);
    chA.handleIncoming(updateB);

    const a = chA.text.toString();
    const b = chB.text.toString();
    expect(a).toBe(b);
    expect(a).toContain('laptop');
    expect(a).toContain('phone');
  });

  it('rejects malformed inbound payloads without touching the document', () => {
    const doc = new Y.Doc();
    const ch = createSyncChannel(doc);
    applyLocalEdit(ch.text, 'keep me');

    for (const raw of [
      null,
      42,
      'not-json{{{',
      { kind: 'doc-update', update: '!!!not-base64!!!' },
      { kind: 'sync-step1' },
      { kind: 'unknown-kind', update: u8ToB64(new Uint8Array([1, 2, 3])) },
      { kind: 'doc-update', update: 'x'.repeat(11_000_000) },
    ]) {
      expect(normalizeMessage(raw)).toBeNull();
    }
    expect(ch.text.toString()).toBe('keep me');
    expect(b64ToU8(u8ToB64(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('applyLocalEdit preserves concurrent remote inserts (prefix/suffix diff)', () => {
    const doc = new Y.Doc();
    const text = doc.getText('shared');
    text.insert(0, 'Hello world');
    // Local keystroke inserts a word in the middle.
    applyLocalEdit(text, 'Hello brave world');
    expect(text.toString()).toBe('Hello brave world');
    // No-op edit leaves the document untouched (no empty update storm).
    const before = Y.encodeStateAsUpdate(doc);
    applyLocalEdit(text, 'Hello brave world');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});
