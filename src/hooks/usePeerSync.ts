import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import { createPeer, getOrCreatePeerId } from '../lib/peer';
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

/**
 * Owns the PeerJS peer, all DataConnections, and the shared Yjs document.
 * Local Yjs updates are broadcast to every open connection; inbound
 * protocol messages are validated and merged back into the same document.
 */
export function usePeerSync(): PeerSync {
  const docRef = useRef<Y.Doc | null>(null);
  if (!docRef.current) docRef.current = new Y.Doc();
  const channel = useMemo(() => createSyncChannel(docRef.current!), []);

  const peerRef = useRef<Peer | null>(null);
  const connsRef = useRef(new Map<string, DataConnection>());

  const [peerId] = useState(() => getOrCreatePeerId());
  const [lifecycle, setLifecycle] = useState<PeerLifecycle>('starting');
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [text, setTextState] = useState('');
  const [lastRemoteAt, setLastRemoteAt] = useState<number | null>(null);

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
        try {
          conn.send(channel.initialMessage());
        } catch {
          // Handled via error/close events below.
        }
      });
      conn.on('data', (raw) => handleData(conn, raw));
      conn.on('close', () => removePeer(conn.peer));
      conn.on('error', () => {
        // Keep the row so the user sees which peer failed; a close
        // event or explicit disconnect will remove it.
      });
    },
    [channel, handleData, removePeer, upsertPeer],
  );

  // Peer lifecycle: create once, destroy on unmount.
  useEffect(() => {
    const peer = createPeer(peerId);
    peerRef.current = peer;
    peer.on('open', () => {
      setLifecycle('open');
      setLifecycleError(null);
    });
    peer.on('connection', (conn) => wireConnection(conn));
    peer.on('disconnected', () => setLifecycle('disconnected'));
    peer.on('close', () => setLifecycle('closed'));
    peer.on('error', (err) => {
      setLifecycleError(err.message);
      if (peer.disconnected) setLifecycle('disconnected');
      else if (peer.destroyed) setLifecycle('closed');
      else setLifecycle('error');
    });
    return () => {
      peerRef.current = null;
      connsRef.current.clear();
      peer.destroy();
    };
  }, [peerId, wireConnection]);

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
      const peer = peerRef.current;
      if (!peer || peer.destroyed) return 'Peer is not ready yet. Wait a moment and retry.';
      try {
        const conn = peer.connect(clean, { reliable: true, serialization: 'json' });
        wireConnection(conn);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not connect.';
      }
    },
    [peerId, wireConnection],
  );

  const disconnectFrom = useCallback(
    (remoteId: string) => {
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
