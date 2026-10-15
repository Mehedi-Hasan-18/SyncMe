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
  const lifecycleRef = useRef<PeerLifecycle>('starting');

  const [peerId] = useState(() => getOrCreatePeerId());
  const [lifecycle, setLifecycleState] = useState<PeerLifecycle>('starting');
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
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

  const wireConnection = useCallback(
    (conn: DataConnection) => {
      connsRef.current.set(conn.peer, conn);
      upsertPeer(conn.peer, 'connecting');
      conn.on('open', () => {
        upsertPeer(conn.peer, 'open');
        rememberPeerId(conn.peer);
        try {
          conn.send(channel.initialMessage());
        } catch {
          // Handled via error/close events below.
        }
      });
      conn.on('data', (raw) => handleData(conn, raw));
      conn.on('close', () => {
        outgoingRef.current.delete(conn.peer);
        removePeer(conn.peer);
      });
      conn.on('error', () => {
        // A close event (or explicit disconnect) cleans the row up.
      });
    },
    [channel, handleData, removePeer, upsertPeer],
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
    peer.on('open', () => {
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
        // Replaced by the incoming channel.
      }
      outgoingRef.current.delete(conn.peer);
      wireConnection(conn);
    });
    peer.on('disconnected', () => setLifecycle('disconnected'));
    peer.on('close', () => setLifecycle('closed'));
    peer.on('error', (err) => {
      const type = (err as unknown as { type?: string }).type;
      const failedId = PEER_UNAVAILABLE_RE.exec(err.message ?? '')?.[1];
      const manual = manualDialRef.current;
      const wasManual =
        manual !== null && manual.id === failedId && Date.now() - manual.at < 15000;
      if (type === 'peer-unavailable' && failedId && !wasManual) {
        // Stale auto-reconnect target (id rotated, app data cleared…):
        // drop it quietly instead of flashing a banner.
        outgoingRef.current.delete(failedId);
        forgetPeerId(failedId);
        removePeer(failedId);
        return;
      }
      setLifecycleError(err.message);
      if (peer.disconnected) setLifecycle('disconnected');
      else if (peer.destroyed) setLifecycle('closed');
      else setLifecycle('error');
    });
    return () => {
      peerRef.current = null;
      connsRef.current.clear();
      outgoingRef.current.clear();
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
      manualDialRef.current = { id: clean, at: Date.now() };
      return dial(clean) ? null : 'Could not start the connection. Check the id and retry.';
    },
    [peerId, dial],
  );

  const disconnectFrom = useCallback(
    (remoteId: string) => {
      forgetPeerId(remoteId);
      outgoingRef.current.delete(remoteId);
      const conn = connsRef.current.get(remoteId);
      try {
        conn?.close();
      } finally {
        removePeer(remoteId);
      }
    },
    [removePeer],
  );

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
    lastRemoteAt,
  };
}
