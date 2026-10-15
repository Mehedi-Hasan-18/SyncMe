import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataConnection } from 'peerjs';
import type { PeerSync } from './usePeerSync';
import {
  CHUNK_SIZE,
  FILE_CHANNEL,
  MAX_BUFFERED,
  MAX_INBOX_ENTRIES,
  TRANSFER_TIMEOUT_MS,
  decodeChunk,
  encodeChunk,
  isRiskyFileName,
  normalizeFileControl,
  randomTransferId,
  sha256HexOfBlob,
  validateOutgoing,
  type RejectedFile,
} from '../lib/transfer';

export type OutStatus = 'offered' | 'sending' | 'done' | 'failed' | 'cancelled';
export type InStatus = 'receiving' | 'verifying' | 'complete' | 'failed' | 'cancelled';

export interface OutgoingTransfer {
  id: string;
  fileName: string;
  size: number;
  mime: string;
  peerId: string;
  status: OutStatus;
  sent: number;
  hash: string;
  risky: boolean;
  error: string | null;
}

export interface IncomingTransfer {
  id: string;
  fileName: string;
  size: number;
  mime: string;
  fromPeerId: string;
  status: InStatus;
  received: number;
  verified: boolean;
  error: string | null;
  blobUrl: string | null;
  risky: boolean;
}

export interface QuickDropApi {
  sendExtension: PeerSync['sendExtension'];
  onExtension: PeerSync['onExtension'];
  openRawConnection: PeerSync['openRawConnection'];
  onRawConnection: PeerSync['onRawConnection'];
}

interface OutRuntime {
  file: File;
  hash: string;
  peerId: string;
  conn: DataConnection | null;
  cancelled: boolean;
  settled: boolean;
  started: boolean;
  lastActivity: number;
}

interface InRuntime {
  parts: BlobPart[];
  receivedBytes: number;
  total: number;
  hash: string;
  mime: string;
  fromPeerId: string;
  conn: DataConnection | null;
  cancelled: boolean;
  settled: boolean;
  /** file-end arrived on the control channel (byte arrival is tracked separately). */
  endReceived: boolean;
  lastActivity: number;
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

function rtcChannel(conn: DataConnection): RTCDataChannel | null {
  return (conn as unknown as { dataChannel?: RTCDataChannel }).dataChannel ?? null;
}

function waitForDrain(dc: RTCDataChannel, ceiling: number): Promise<void> {
  if (dc.bufferedAmount <= ceiling) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    // Backstop for browsers without bufferedamountlow support.
    setTimeout(done, 5000);
  });
}

/**
 * QuickDrop: chunked peer-to-peer file transfer with backpressure,
 * SHA-256 integrity, cancel, and retry. Files are never uploaded anywhere —
 * chunks travel over a dedicated binary DataConnection between the devices.
 */
export function useQuickDrop(api: QuickDropApi) {
  const [outbox, setOutbox] = useState<OutgoingTransfer[]>([]);
  const [inbox, setInbox] = useState<IncomingTransfer[]>([]);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);

  const outRt = useRef(new Map<string, OutRuntime>());
  const inRt = useRef(new Map<string, InRuntime>());
  const activePeer = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const apiRef = useRef(api);
  apiRef.current = api;

  const patchOut = useCallback((id: string, patch: Partial<OutgoingTransfer>) => {
    setOutbox((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const patchIn = useCallback((id: string, patch: Partial<IncomingTransfer>) => {
    setInbox((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const failOut = useCallback(
    (id: string, error: string) => {
      const rt = outRt.current.get(id);
      if (!rt || rt.settled) return;
      rt.settled = true;
      try {
        rt.conn?.close();
      } catch {
        // Already dead.
      }
      patchOut(id, { status: 'failed', error });
    },
    [patchOut],
  );

  const failIn = useCallback(
    (id: string, error: string) => {
      const rt = inRt.current.get(id);
      if (!rt || rt.settled) return;
      rt.settled = true;
      rt.parts = [];
      try {
        rt.conn?.close();
      } catch {
        // Already dead.
      }
      patchIn(id, { status: 'failed', error });
    },
    [patchIn],
  );

  const pumpNext = useCallback(
    (peerId: string) => {
      activePeer.current.delete(peerId);
      const idx = queue.current.findIndex((id) => outRt.current.get(id)?.peerId === peerId);
      if (idx >= 0) {
        const [next] = queue.current.splice(idx, 1);
        void runSendRef.current(next);
      }
    },
    [],
  );

  const runSendRef = useRef<(id: string) => Promise<void>>(async () => {});

  const runSend = useCallback(
    async (id: string) => {
      const rt = outRt.current.get(id);
      if (!rt || rt.settled) {
        pumpNext(rt?.peerId ?? '');
        return;
      }
      if (rt.cancelled) {
        rt.settled = true;
        patchOut(id, { status: 'cancelled', error: null });
        pumpNext(rt.peerId);
        return;
      }
      const live = apiRef.current;
      activePeer.current.add(rt.peerId);
      rt.started = true;
      rt.lastActivity = Date.now();
      patchOut(id, { status: 'sending', error: null });
      try {
        if (
          !live.sendExtension(rt.peerId, FILE_CHANNEL, {
            type: 'file-offer',
            id,
            name: rt.file.name,
            size: rt.file.size,
            mime: rt.file.type,
            sha256: rt.hash,
          })
        ) {
          throw new Error('Peer is not connected.');
        }
        const conn = await live.openRawConnection(rt.peerId, {
          label: FILE_CHANNEL,
          serialization: 'binary',
          reliable: true,
          metadata: { transferId: id },
        });
        if (rt.cancelled) {
          try {
            conn.close();
          } catch {
            // Already dead.
          }
          throw new Cancelled();
        }
        rt.conn = conn;
        conn.on('close', () => {
          if (!rt.settled) failOut(id, 'Connection lost mid-transfer.');
        });
        conn.on('error', () => {
          if (!rt.settled) failOut(id, 'Connection failed mid-transfer.');
        });
        const dc = rtcChannel(conn);
        if (dc) {
          try {
            dc.bufferedAmountLowThreshold = MAX_BUFFERED;
          } catch {
            // Optional tuning; the loop re-checks bufferedAmount regardless.
          }
        }
        let offset = 0;
        let index = 0;
        while (offset < rt.file.size) {
          if (rt.cancelled) throw new Cancelled();
          if (dc && dc.bufferedAmount > MAX_BUFFERED) await waitForDrain(dc, MAX_BUFFERED);
          if (rt.cancelled) throw new Cancelled();
          const buf = await rt.file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
          if (rt.cancelled) throw new Cancelled();
          try {
            conn.send(encodeChunk(id, index, buf));
          } catch {
            throw new Error('Send failed — the connection dropped.');
          }
          offset += buf.byteLength;
          index += 1;
          rt.lastActivity = Date.now();
          patchOut(id, { sent: offset });
        }
        // All bytes flushed into SCTP; completion is confirmed by receipt.
        live.sendExtension(rt.peerId, FILE_CHANNEL, { type: 'file-end', id, sha256: rt.hash });
        // No receiver confirmation by design (auto-accept): the sender is
        // done once every byte is flushed and file-end is sent. Integrity is
        // verified receiver-side and shown as its own state there.
        //
        // Settle BEFORE closing: the receiver owns the outcome from here.
        // Then drain the channel to zero and linger briefly — closing with
        // bytes still in SCTP buffers silently discards the tail.
        rt.settled = true;
        if (dc) {
          const drainStart = Date.now();
          while (dc.bufferedAmount > 0 && Date.now() - drainStart < 15_000) {
            await waitForDrain(dc, 0);
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (rt.cancelled) {
          patchOut(id, { status: 'cancelled', error: null });
          live.sendExtension(rt.peerId, FILE_CHANNEL, { type: 'file-cancel', id });
        } else {
          patchOut(id, { status: 'done', sent: rt.file.size, error: null });
        }
      } catch (err) {
        if (err instanceof Cancelled || rt.cancelled) {
          rt.settled = true;
          patchOut(id, { status: 'cancelled', error: null });
          live.sendExtension(rt.peerId, FILE_CHANNEL, { type: 'file-cancel', id });
        } else if (!rt.settled) {
          failOut(id, err instanceof Error ? err.message : 'Transfer failed.');
        }
      } finally {
        try {
          rt.conn?.close();
        } catch {
          // Already dead.
        }
        rt.conn = null;
        pumpNext(rt.peerId);
      }
    },
    [failOut, patchOut, pumpNext],
  );
  runSendRef.current = runSend;

  const enqueueSend = useCallback(
    (peerId: string, file: File, hash: string) => {
      const id = randomTransferId();
      const risky = isRiskyFileName(file.name);
      outRt.current.set(id, {
        file,
        hash,
        peerId,
        conn: null,
        cancelled: false,
        settled: false,
        started: false,
        lastActivity: Date.now(),
      });
      setOutbox((prev) => [
        ...prev,
        {
          id,
          fileName: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          peerId,
          status: 'offered',
          sent: 0,
          hash,
          risky,
          error: null,
        },
      ]);
      if (activePeer.current.has(peerId)) {
        queue.current.push(id);
      } else {
        void runSend(id);
      }
    },
    [runSend],
  );

  const sendFiles = useCallback(
    async (peerId: string, files: File[]) => {
      const { accepted, rejected: bad } = validateOutgoing(files);
      if (bad.length > 0) setRejected((prev) => [...bad, ...prev].slice(0, 10));
      for (const { file } of accepted) {
        try {
          const hash = await sha256HexOfBlob(file);
          enqueueSend(peerId, file, hash);
        } catch {
          const id = randomTransferId();
          outRt.current.set(id, {
            file,
            hash: '',
            peerId,
            conn: null,
            cancelled: false,
            settled: true,
            started: false,
            lastActivity: Date.now(),
          });
          setOutbox((prev) => [
            ...prev,
            {
              id,
              fileName: file.name,
              size: file.size,
              mime: file.type || 'application/octet-stream',
              peerId,
              status: 'failed',
              sent: 0,
              hash: '',
              risky: isRiskyFileName(file.name),
              error: 'Could not read this file.',
            },
          ]);
        }
      }
    },
    [enqueueSend],
  );

  const cancelSend = useCallback(
    (id: string) => {
      const rt = outRt.current.get(id);
      if (!rt || rt.settled) return;
      rt.cancelled = true;
      if (!rt.started) {
        // Still queued: settle immediately so it never starts.
        queue.current = queue.current.filter((q) => q !== id);
        rt.settled = true;
        apiRef.current.sendExtension(rt.peerId, FILE_CHANNEL, { type: 'file-cancel', id });
        patchOut(id, { status: 'cancelled', error: null });
      }
      // A running send observes the flag on its next iteration.
    },
    [patchOut],
  );

  const retrySend = useCallback(
    (id: string) => {
      const prev = outRt.current.get(id);
      if (!prev || !prev.settled || !prev.hash) return;
      outRt.current.delete(id);
      setOutbox((prevBox) => prevBox.filter((t) => t.id !== id));
      enqueueSend(prev.peerId, prev.file, prev.hash);
    },
    [enqueueSend],
  );

  const cancelReceive = useCallback(
    (id: string) => {
      const rt = inRt.current.get(id);
      if (!rt || rt.settled) return;
      rt.settled = true;
      rt.cancelled = true;
      rt.parts = [];
      try {
        rt.conn?.close();
      } catch {
        // Already dead.
      }
      apiRef.current.sendExtension(rt.fromPeerId, FILE_CHANNEL, { type: 'file-cancel', id });
      patchIn(id, { status: 'cancelled', error: null });
    },
    [patchIn],
  );

  const clearFinished = useCallback(() => {
    setOutbox((prev) => {
      const done = prev.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled');
      for (const t of done) outRt.current.delete(t.id);
      return prev.filter((t) => !(t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'));
    });
    setInbox((prev) => {
      const done = prev.filter(
        (t) => t.status === 'complete' || t.status === 'failed' || t.status === 'cancelled',
      );
      for (const t of done) {
        if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
        inRt.current.delete(t.id);
      }
      return prev.filter(
        (t) => !(t.status === 'complete' || t.status === 'failed' || t.status === 'cancelled'),
      );
    });
    setRejected([]);
  }, []);

  // Inbound control -----------------------------------------------------------
  useEffect(() => {
    const live = apiRef.current;
    const offExt = live.onExtension(FILE_CHANNEL, (fromPeerId, raw) => {
      const msg = normalizeFileControl(raw);
      if (!msg) return;
      if (msg.type === 'file-offer') {
        if (inRt.current.has(msg.id) || inRt.current.size >= MAX_INBOX_ENTRIES) return;
        inRt.current.set(msg.id, {
          parts: [],
          receivedBytes: 0,
          total: msg.size,
          hash: msg.sha256,
          mime: msg.mime,
          fromPeerId,
          conn: null,
          cancelled: false,
          settled: false,
          endReceived: false,
          lastActivity: Date.now(),
        });
        setInbox((prev) => [
          ...prev,
          {
            id: msg.id,
            fileName: msg.name,
            size: msg.size,
            mime: msg.mime,
            fromPeerId,
            status: 'receiving',
            received: 0,
            verified: false,
            error: null,
            blobUrl: null,
            risky: false,
          },
        ]);
        return;
      }
      if (msg.type === 'file-end') {
        // Control and bytes ride different channels with no cross-ordering:
        // verify only once BOTH the end marker and every declared byte
        // have arrived (either may legitimately come first).
        const rt = inRt.current.get(msg.id);
        if (rt && !rt.settled && !rt.cancelled) {
          rt.endReceived = true;
          rt.lastActivity = Date.now();
          if (rt.receivedBytes >= rt.total) {
            void finalizeIncomingRef.current(msg.id, msg.sha256);
          }
        }
        return;
      }
      // file-cancel: settle whichever side of this transfer is live here.
      const ort = outRt.current.get(msg.id);
      if (ort && !ort.settled) {
        ort.settled = true;
        ort.cancelled = true;
        try {
          ort.conn?.close();
        } catch {
          // Already dead.
        }
        queue.current = queue.current.filter((q) => q !== msg.id);
        patchOut(msg.id, { status: 'cancelled', error: null });
        pumpNext(ort.peerId);
      }
      const irt = inRt.current.get(msg.id);
      if (irt && !irt.settled) {
        irt.settled = true;
        irt.cancelled = true;
        irt.parts = [];
        try {
          irt.conn?.close();
        } catch {
          // Already dead.
        }
        patchIn(msg.id, { status: 'cancelled', error: null });
      }
    });

    const offRaw = live.onRawConnection(FILE_CHANNEL, (conn) => {
      const meta = (conn as unknown as { metadata?: unknown }).metadata;
      const transferId =
        typeof meta === 'object' && meta !== null && 'transferId' in meta
          ? (meta as { transferId?: unknown }).transferId
          : undefined;
      const rt =
        typeof transferId === 'string' ? inRt.current.get(transferId) : undefined;
      if (!rt || rt.settled || rt.cancelled || rt.conn) {
        try {
          conn.close();
        } catch {
          // Unknown or duplicate channel.
        }
        return;
      }
      rt.conn = conn;
      rt.lastActivity = Date.now();
      conn.on('data', (raw) => {
        if (rt.settled || rt.cancelled) return;
        const frame = decodeChunk(raw);
        if (!frame || frame.id !== transferId) return;
        rt.parts.push(frame.payload);
        rt.receivedBytes += frame.payload.byteLength;
        rt.lastActivity = Date.now();
        if (rt.receivedBytes > rt.total + 16 * 1024) {
          failIn(transferId as string, 'Sender exceeded the declared size — aborted.');
          return;
        }
        patchIn(transferId as string, { received: rt.receivedBytes });
        if (rt.endReceived && rt.receivedBytes >= rt.total) {
          void finalizeIncomingRef.current(transferId as string, rt.hash);
        }
      });
      conn.on('close', () => {
        if (!rt.settled) failIn(transferId as string, 'Connection lost mid-transfer.');
      });
      conn.on('error', () => {
        if (!rt.settled) failIn(transferId as string, 'Connection failed mid-transfer.');
      });
    });

    return () => {
      offExt();
      offRaw();
    };
  }, [api.sendExtension, api.onExtension, api.openRawConnection, api.onRawConnection, patchIn, patchOut, failIn, pumpNext]);

  const finalizeIncomingRef = useRef<(id: string, claimedHash: string) => Promise<void>>(
    async () => {},
  );

  const finalizeIncoming = useCallback(
    async (id: string, claimedHash: string) => {
      const rt = inRt.current.get(id);
      if (!rt || rt.settled || rt.cancelled) return;
      rt.settled = true;
      patchIn(id, { status: 'verifying' });
      try {
        const blob = new Blob(rt.parts, { type: rt.mime });
        rt.parts = [];
        const actual = await sha256HexOfBlob(blob);
        if (actual !== claimedHash.toLowerCase()) {
          throw new Error('Hash mismatch — the file was corrupted in transit.');
        }
        const url = URL.createObjectURL(blob);
        patchIn(id, {
          status: 'complete',
          received: blob.size,
          verified: true,
          blobUrl: url,
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification failed.';
        patchIn(id, { status: 'failed', error: message });
      } finally {
        try {
          rt.conn?.close();
        } catch {
          // Already dead.
        }
        rt.conn = null;
      }
    },
    [patchIn],
  );
  finalizeIncomingRef.current = finalizeIncoming;

  // Stall watchdog: no bytes for 30s means a dead transfer, not a slow one.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [id, rt] of outRt.current) {
        if (rt.started && !rt.settled && now - rt.lastActivity > TRANSFER_TIMEOUT_MS) {
          failOut(id, 'Stalled — no progress for 30s. The connection may have dropped.');
          pumpNext(rt.peerId);
        }
      }
      for (const [id, rt] of inRt.current) {
        if (!rt.settled && now - rt.lastActivity > TRANSFER_TIMEOUT_MS) {
          failIn(id, 'Stalled — no data for 30s. Ask the sender to retry.');
        }
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [failOut, failIn, pumpNext]);

  return { outbox, inbox, rejected, sendFiles, cancelSend, retrySend, cancelReceive, clearFinished };
}
