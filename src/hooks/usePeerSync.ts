import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import {
  createPeer,
  forgetPeerId,
  getOrCreatePeerId,
  loadKnownPeers,
  rememberPeerId,
} from '../lib/peer';
import { shortId } from '../lib/device';
import {
  REMOTE_ORIGIN,
  applyLocalEdit,
  createSyncChannel,
  normalizeMessage,
} from '../lib/sync';

export type PeerLifecycle = 'starting' | 'open' | 'disconnected' | 'closed' | 'error';

export interface RemotePeer {
  id: string;
  status: 'connecting' | 'open';
}

export interface PeerSync {
  peerId: string;
  lifecycle: PeerLifecycle;
  lifecycleError: string | null;
  peers: RemotePeer[];
  peerCount: number;
  /** Current shared text (local + converged remote edits). */
  text: string;
  setText: (next: string) => void;
  connectTo: (remoteId: string) => string | null;
  disconnectFrom: (remoteId: string) => void;
  /** Last async connection failure (timeout, unreachable, ICE failure). */
  connectError: string | null;
  clearConnectError: () => void;
  /** Close every link and forget every device (e.g. after our access is revoked). */
  disconnectAll: () => void;
  /** Timestamp of the last applied remote edit, for "peer is typing" hints. */
  lastRemoteAt: number | null;
}

/** Matches PeerJS's "Could not connect to peer <id>" unavailable error. */
const PEER_UNAVAILABLE_RE = /Could not connect to peer (\w+)/;

/**
 * Owns the PeerJS peer, all DataConnections, and the shared Yjs document.
 * Local Yjs updates are broadcast to every open connection; inbound
 * protocol messages are validated and merged back into the same document.
 *
 * Linked device ids are remembered on-device (localStorage) so a page
 * reload auto-reconnects instead of forcing another manual copy-paste.
 */
export function usePeerSync(): PeerSync {
  const docRef = useRef<Y.Doc | null>(null);
  if (!docRef.current) docRef.current = new Y.Doc();
  const channel = useMemo(() => createSyncChannel(docRef.current!), []);

  const peerRef = useRef<Peer | null>(null);
  const connsRef = useRef(new Map<string, DataConnection>());
  const outgoingRef = useRef(new Set<string>());
  const autoTriedRef = useRef(new Set<string>());
  const manualDialRef = useRef<{ id: string; at: number } | null>(null);
  const expectedCloseRef = useRef(new Set<string>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lifecycleRef = useRef<PeerLifecycle>('starting');

  const [peerId] = useState(() => getOrCreatePeerId());
  const [lifecycle, setLifecycleState] = useState<PeerLifecycle>('starting');
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [text, setTextState] = useState('');
  const [lastRemoteAt, setLastRemoteAt] = useState<number | null>(null);

  const setLifecycle = useCallback((next: PeerLifecycle) => {
    lifecycleRef.current = next;
    setLifecycleState(next);
  }, []);

  const upsertPeer = useCallback((id: string, status: RemotePeer['status']) => {
    setPeers((prev) => {
      const rest = prev.filter((p) => p.id !== id);
      return [...rest, { id, status }];
    });
  }, []);

  const removePeer = useCallback((id: string) => {
    connsRef.current.delete(id);
    setPeers((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleData = useCallback(
    (conn: DataConnection, raw: unknown) => {
      const msg = normalizeMessage(raw);
      if (!msg) return;
      const { reply, updated } = channel.handleIncoming(msg);
      if (reply) {
        try {
          conn.send(reply);
        } catch {
          // Send failures surface via the connection's error/close events.
        }
      }
      if (updated) setLastRemoteAt(Date.now());
    },
    [channel],
  );

  const clearConnectError = useCallback(() => setConnectError(null), []);

  /** Drop a failed/stuck connection and tell the user why, in plain language. */
  const failConnection = useCallback(
    (id: string, reason: string) => {
      outgoingRef.current.delete(id);
      expectedCloseRef.current.add(id);
      const conn = connsRef.current.get(id);
      try {
        conn?.close();
      } catch {
        // Already dead.
      }
      removePeer(id);
      setConnectError(reason);
    },
    [removePeer],
  );

  const wireConnection = useCallback(
    (conn: DataConnection) => {
      connsRef.current.set(conn.peer, conn);
      upsertPeer(conn.peer, 'connecting');
      // Guards against superseded duplicates: only the connection currently
      // registered for a peer may touch its row or report errors. A stale
      // duplicate dying must never kill the surviving channel.
      const isCurrent = () => connsRef.current.get(conn.peer) === conn;
      // A link that never opens is worse than a clear error: time it out.
      const openTimer = setTimeout(() => {
        if (isCurrent() && !conn.open) {
          failConnection(
            conn.peer,
            `Couldn't reach ${shortId(conn.peer)} within 20s — is SyncMe open on that device, on the same Wi-Fi?`,
          );
        }
      }, 20_000);
      conn.on('open', () => {
        if (!isCurrent()) {
          try {
            conn.close();
          } catch {
            // Superseded duplicate.
          }
          return;
        }
        clearTimeout(openTimer);
        upsertPeer(conn.peer, 'open');
        rememberPeerId(conn.peer);
        setConnectError(null);
        try {
          conn.send(channel.initialMessage());
        } catch {
          // Handled via error/close events below.
        }
      });
      conn.on('data', (raw) => {
        if (isCurrent()) handleData(conn, raw);
      });
      conn.on('close', () => {
        clearTimeout(openTimer);
        if (!isCurrent()) return;
        outgoingRef.current.delete(conn.peer);
        const expected = expectedCloseRef.current.delete(conn.peer);
        const wasOpen = connsRef.current.has(conn.peer);
        removePeer(conn.peer);
        if (!expected && wasOpen) {
          setConnectError(`Connection to ${shortId(conn.peer)} was lost.`);
        }
      });
      conn.on('error', (err) => {
        clearTimeout(openTimer);
        if (!isCurrent()) return;
        const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
        failConnection(conn.peer, `Connection to ${shortId(conn.peer)} failed${detail}. Retry once both devices show “online”.`);
      });
      conn.on('iceStateChanged', (state) => {
        // ICE gave up before the channel ever opened (NAT/firewall). Only
        // terminal states — a pre-open 'disconnected' can still recover and
        // the 20s timeout remains as the backstop.
        if ((state === 'failed' || state === 'closed') && isCurrent() && !conn.open) {
          clearTimeout(openTimer);
          failConnection(
            conn.peer,
            `Couldn't establish a direct link to ${shortId(conn.peer)} (network). Keep both devices on the same Wi-Fi and retry.`,
          );
        }
      });
    },
    [channel, handleData, removePeer, upsertPeer, failConnection],
  );

  const dial = useCallback(
    (remoteId: string): DataConnection | null => {
      const peer = peerRef.current;
      if (!peer || peer.destroyed || peer.disconnected) return null;
      const existing = connsRef.current.get(remoteId);
      if (existing) return existing;
      try {
        const conn = peer.connect(remoteId, { reliable: true, serialization: 'json' });
        outgoingRef.current.add(remoteId);
        wireConnection(conn);
        return conn;
      } catch {
        outgoingRef.current.delete(remoteId);
        return null;
      }
    },
    [wireConnection],
  );

  // Peer lifecycle: create once, destroy on unmount.
  useEffect(() => {
    const peer = createPeer(peerId);
    peerRef.current = peer;

    const scheduleReconnect = (delayMs: number) => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        const current = peerRef.current;
        if (!current || current.destroyed || !current.disconnected) return;
        if (reconnectAttemptsRef.current >= 5) {
          setLifecycleError('Lost the signaling connection. Reload the page to reconnect.');
          return;
        }
        reconnectAttemptsRef.current += 1;
        try {
          current.reconnect();
        } catch {
          scheduleReconnect(3000);
        }
      }, delayMs);
    };

    peer.on('open', () => {
      reconnectAttemptsRef.current = 0;
      setLifecycle('open');
      setLifecycleError(null);
      // Auto-reconnect to previously linked devices (e.g. after a reload).
      for (const id of loadKnownPeers(peerId)) {
        if (autoTriedRef.current.has(id) || connsRef.current.has(id)) continue;
        autoTriedRef.current.add(id);
        dial(id);
      }
    });
    peer.on('connection', (conn) => {
      // Both sides dialed at once (typical after a reload on both ends):
      // keep exactly one channel via a deterministic tie-break so we never
      // end up with duplicate connections.
      const existing = connsRef.current.get(conn.peer);
      const oursPending = outgoingRef.current.has(conn.peer);
      if ((existing?.open || oursPending) && peerId > conn.peer) {
        try {
          conn.close();
        } catch {
          // Duplicate incoming channel dropped; ours survives.
        }
        return;
      }
      try {
        existing?.close();
      } catch {
        // Replaced by the incoming channel. Its close event is ignored via
        // the isCurrent() guard — it is no longer the registered channel.
      }
      outgoingRef.current.delete(conn.peer);
      wireConnection(conn);
    });
    peer.on('disconnected', () => {
      setLifecycle('disconnected');
      // Signaling drops happen (sleep, network blips) — rejoin automatically.
      scheduleReconnect(2000);
    });
    peer.on('close', () => setLifecycle('closed'));
    peer.on('error', (err) => {
      if (peer.destroyed) {
        // Teardown noise (dev StrictMode remount, unmount): never banner it.
        setLifecycle('closed');
        return;
      }
      const type = (err as unknown as { type?: string }).type;
      const failedId = PEER_UNAVAILABLE_RE.exec(err.message ?? '')?.[1];
      const manual = manualDialRef.current;
      const wasManual =
        manual !== null && manual.id === failedId && Date.now() - manual.at < 15000;
      if (type === 'peer-unavailable' && failedId) {
        outgoingRef.current.delete(failedId);
        removePeer(failedId);
        if (wasManual) {
          // The user just typed this id: explain, don't touch signaling state.
          setConnectError(
            `Couldn't reach ${shortId(failedId)} — check the id and confirm SyncMe is open on that device.`,
          );
        } else {
          // Stale auto-reconnect target (id rotated, app data cleared…):
          // drop it quietly instead of flashing a banner.
          forgetPeerId(failedId);
        }
        return;
      }
      if (peer.disconnected) {
        setLifecycle('disconnected');
        scheduleReconnect(3000);
        return;
      }
      setLifecycleError(err.message);
      if (peer.destroyed) setLifecycle('closed');
      else setLifecycle('error');
    });
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      peerRef.current = null;
      connsRef.current.clear();
      outgoingRef.current.clear();
      expectedCloseRef.current.clear();
      peer.destroy();
    };
  }, [peerId, wireConnection, dial, removePeer, setLifecycle]);

  // Broadcast local edits to every open connection.
  useEffect(() => {
    const doc = docRef.current!;
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      const msg = channel.createDocUpdate(update);
      for (const conn of connsRef.current.values()) {
        if (conn.open) {
          try {
            conn.send(msg);
          } catch {
            // Connection-level errors are handled by its own events.
          }
        }
      }
    };
    doc.on('update', onUpdate);
    return () => {
      doc.off('update', onUpdate);
    };
  }, [channel]);

  // Mirror the shared Y.Text into React state.
  useEffect(() => {
    const { text: ytext } = channel;
    setTextState(ytext.toString());
    const observer = (_event: Y.YTextEvent, txn: Y.Transaction) => {
      setTextState(ytext.toString());
      if (txn.origin === REMOTE_ORIGIN) setLastRemoteAt(Date.now());
    };
    ytext.observe(observer);
    return () => {
      ytext.unobserve(observer);
    };
  }, [channel]);

  const setText = useCallback(
    (next: string) => {
      applyLocalEdit(channel.text, next);
      setTextState(channel.text.toString());
    },
    [channel],
  );

  const connectTo = useCallback(
    (remoteId: string): string | null => {
      const clean = remoteId.trim();
      if (!clean) return 'Enter a peer id.';
      if (clean === peerId) return 'That is this device’s own id.';
      if (connsRef.current.has(clean)) return 'Already connected to that device.';
      if (lifecycleRef.current !== 'open') {
        return 'Signaling isn’t ready yet — wait for “online”, then retry.';
      }
      setConnectError(null);
      manualDialRef.current = { id: clean, at: Date.now() };
      return dial(clean) ? null : 'Could not start the connection. Check the id and retry.';
    },
    [peerId, dial],
  );

  const disconnectFrom = useCallback(
    (remoteId: string) => {
      setConnectError(null);
      forgetPeerId(remoteId);
      outgoingRef.current.delete(remoteId);
      expectedCloseRef.current.add(remoteId);
      const conn = connsRef.current.get(remoteId);
      try {
        conn?.close();
      } finally {
        removePeer(remoteId);
      }
    },
    [removePeer],
  );

  const disconnectAll = useCallback(() => {
    setConnectError(null);
    for (const id of connsRef.current.keys()) {
      expectedCloseRef.current.add(id);
      forgetPeerId(id);
    }
    for (const conn of connsRef.current.values()) {
      try {
        conn.close();
      } catch {
        // Already dead.
      }
    }
    connsRef.current.clear();
    outgoingRef.current.clear();
    setPeers([]);
  }, []);

  return {
    peerId,
    lifecycle,
    lifecycleError,
    peers,
    peerCount: peers.filter((p) => p.status === 'open').length,
    text,
    setText,
    connectTo,
    disconnectFrom,
    connectError,
    clearConnectError,
    disconnectAll,
    lastRemoteAt,
  };
}
