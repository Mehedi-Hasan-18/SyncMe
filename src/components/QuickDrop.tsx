import { useRef, useState } from 'react';
import type { RemotePeer } from '../hooks/usePeerSync';
import { useQuickDrop, type QuickDropApi } from '../hooks/useQuickDrop';
import {
  MAX_FILE_SIZE_LABEL,
  MAX_FILES_PER_BATCH,
  progressPercent,
  validateOutgoing,
} from '../lib/transfer';

interface Props {
  api: QuickDropApi;
  peers: RemotePeer[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    offered: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
    sending: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
    receiving: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
    verifying: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    complete: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    cancelled: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[status] ?? styles.offered}`}>
      {status}
    </span>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${value}%` }} />
    </div>
  );
}

export function QuickDrop({ api, peers }: Props) {
  const { outbox, inbox, rejected, sendFiles, cancelSend, retrySend, cancelReceive, clearFinished } =
    useQuickDrop(api);
  const [target, setTarget] = useState('');
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [staged, setStaged] = useState<File[]>([]);
  const [stagedRejects, setStagedRejects] = useState<{ name: string; reason: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const openPeers = peers.filter((p) => p.status === 'open');
  const activeTarget = openPeers.find((p) => p.id === target) ?? openPeers[0] ?? null;
  const hasFinished =
    outbox.some((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') ||
    inbox.some((t) => t.status === 'complete' || t.status === 'failed' || t.status === 'cancelled');

  const submitFiles = async (files: File[]) => {
    if (files.length === 0) return;
    // Validate at stage time so oversize picks are rejected immediately,
    // even before any device is connected.
    const { accepted, rejected: bad } = validateOutgoing(files);
    if (bad.length > 0) {
      setStagedRejects((prev) => [...bad, ...prev].slice(0, 10));
    }
    if (accepted.length > 0) {
      setStaged((prev) => [...prev, ...accepted.map((a) => a.file)].slice(0, MAX_FILES_PER_BATCH));
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const sendStaged = async () => {
    if (!activeTarget || staged.length === 0 || sending) return;
    setSending(true);
    try {
      await sendFiles(activeTarget.id, staged);
      setStaged([]);
    } finally {
      setSending(false);
    }
  };

  const card =
    'rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900';

  return (
    <section aria-label="QuickDrop file transfer" className={card}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">QuickDrop</h2>
        {hasFinished && (
          <button
            type="button"
            onClick={clearFinished}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Clear finished
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Send files straight to a connected device — peer-to-peer, up to {MAX_FILE_SIZE_LABEL} per
        file, {MAX_FILES_PER_BATCH} per batch. Nothing is uploaded anywhere.
      </p>

      {openPeers.length === 0 ? (
        <p className="mt-3 rounded-lg bg-zinc-100 p-2.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          Connect a device first (above) to send — you can already pick files below.
        </p>
      ) : null}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void submitFiles([...e.dataTransfer.files]);
        }}
        className={`mt-3 rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
          dragOver
            ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950'
            : 'border-zinc-300 dark:border-zinc-700'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Choose files to send"
          onChange={(e) => {
            void submitFiles([...(e.target.files ?? [])]);
          }}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {dragOver ? 'Drop to stage' : 'Drag files here, or'}
        </p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="mt-2 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Choose files
        </button>
      </div>

      {staged.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            Ready to send ({staged.length})
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {staged.map((f, i) => (
              <li
                key={`${f.name}-${f.size}-${i}`}
                className="flex items-center justify-between gap-2 rounded-lg bg-zinc-100 px-2.5 py-1.5 dark:bg-zinc-800"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium" title={f.name}>
                    {f.name}
                  </span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                    {formatBytes(f.size)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setStaged((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-zinc-700"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            {openPeers.length > 0 ? (
              <>
                <label htmlFor="qd-target" className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                  Send to
                </label>
                <select
                  id="qd-target"
                  value={activeTarget?.id ?? ''}
                  onChange={(e) => setTarget(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-2 py-2 font-mono text-xs focus:border-emerald-500 focus:outline-none dark:border-zinc-700"
                >
                  {openPeers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id.slice(0, 12)}…
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={sendStaged}
                  disabled={sending || staged.length === 0}
                  className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {sending ? 'Preparing…' : `Send${staged.length > 1 ? ` ${staged.length}` : ''}`}
                </button>
              </>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {staged.length} file{staged.length === 1 ? '' : 's'} staged — they’ll send once a
                device connects.
              </p>
            )}
          </div>
        </div>
      )}

      {(rejected.length > 0 || stagedRejects.length > 0) && (
        <ul className="mt-3 space-y-1">
          {[...stagedRejects, ...rejected].map((r, i) => (
            <li key={`${r.name}-${i}`} role="alert" className="text-xs text-red-600 dark:text-red-400">
              {r.name}: {r.reason}
            </li>
          ))}
        </ul>
      )}

      {outbox.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            Sent ({outbox.length})
          </h3>
          <ul className="mt-1.5 space-y-2">
            {outbox.map((t) => (
              <li key={t.id} className="rounded-lg bg-zinc-100 p-2.5 dark:bg-zinc-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium" title={t.fileName}>
                      {t.fileName}
                    </span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                      {formatBytes(t.size)} → {t.peerId.slice(0, 12)}… · {formatBytes(t.sent)} sent
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <StatusPill status={t.status} />
                    {(t.status === 'sending' || t.status === 'offered') && (
                      <button
                        type="button"
                        onClick={() => cancelSend(t.id)}
                        className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        Cancel
                      </button>
                    )}
                    {t.status === 'failed' && t.hash && (
                      <button
                        type="button"
                        onClick={() => retrySend(t.id)}
                        className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        Retry
                      </button>
                    )}
                  </span>
                </div>
                <div className="mt-1.5">
                  <Bar value={progressPercent(t.sent, t.size)} />
                </div>
                {t.risky && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    Executable file — only open it on the receiving device if you trust it.
                  </p>
                )}
                {t.error && (
                  <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                    {t.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {inbox.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            Incoming ({inbox.length})
          </h3>
          <ul className="mt-1.5 space-y-2">
            {inbox.map((t) => (
              <li key={t.id} className="rounded-lg bg-zinc-100 p-2.5 dark:bg-zinc-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium" title={t.fileName}>
                      {t.fileName}
                    </span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                      {formatBytes(t.size)} ← {t.fromPeerId.slice(0, 12)}… ·{' '}
                      {formatBytes(t.received)} received
                      {t.verified && ' · integrity verified ✓'}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <StatusPill status={t.status} />
                    {(t.status === 'receiving' || t.status === 'verifying') && (
                      <button
                        type="button"
                        onClick={() => cancelReceive(t.id)}
                        className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        Cancel
                      </button>
                    )}
                    {t.status === 'complete' && t.blobUrl && (
                      <a
                        href={t.blobUrl}
                        download={t.fileName}
                        className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        Save
                      </a>
                    )}
                  </span>
                </div>
                <div className="mt-1.5">
                  <Bar value={progressPercent(t.received, t.size)} />
                </div>
                {t.error && (
                  <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                    {t.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
