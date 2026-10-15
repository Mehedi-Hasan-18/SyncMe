import { useState } from 'react';
import type { RemotePeer } from '../hooks/usePeerSync';

interface Props {
  peers: RemotePeer[];
  peerId: string;
  ready: boolean;
  connectError: string | null;
  onClearConnectError: () => void;
  onConnect: (remoteId: string) => string | null;
  onDisconnect: (remoteId: string) => void;
}

export function ConnectPanel({ peers, peerId, ready, connectError, onClearConnectError, onConnect, onDisconnect }: Props) {
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyOwnId = async () => {
    try {
      await navigator.clipboard.writeText(peerId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFormError('Copy failed — select the id above and copy manually.');
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const err = onConnect(input);
    setFormError(err);
    if (!err) setInput('');
  };

  return (
    <section aria-label="Connect devices" className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold">Connect a device</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Open SyncMe on your other device, copy <em>its</em> device id, and paste it here. Either side can
        initiate — the link is peer-to-peer.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-zinc-100 px-2.5 py-2 font-mono text-xs dark:bg-zinc-800" title={peerId}>
          {peerId}
        </code>
        <button
          type="button"
          onClick={copyOwnId}
          className="shrink-0 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {copied ? 'Copied ✓' : 'Copy my id'}
        </button>
      </div>

      <form onSubmit={submit} className="mt-3 flex gap-2">
        <label htmlFor="remote-id" className="sr-only">
          Other device’s id
        </label>
        <input
          id="remote-id"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste other device’s id…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono text-xs placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          disabled={!ready || !input.trim()}
          title={ready ? 'Connect' : 'Waiting for signaling…'}
        >
          {ready ? 'Connect' : 'Waiting…'}
        </button>
      </form>
      {!ready && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          Waiting for signaling to come online — the button enables automatically.
        </p>
      )}
      {formError && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}
      {connectError && (
        <p role="alert" className="mt-2 flex items-start justify-between gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          <span>{connectError}</span>
          <button
            type="button"
            onClick={onClearConnectError}
            aria-label="Dismiss connection error"
            className="shrink-0 rounded px-1 font-bold hover:bg-red-100 dark:hover:bg-red-900"
          >
            ✕
          </button>
        </p>
      )}

      <div className="mt-3">
        <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          Connected devices ({peers.length})
        </h3>
        {peers.length === 0 ? (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            No devices connected yet. Connect your phone and laptop to start syncing.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {peers.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-zinc-100 px-2.5 py-1.5 dark:bg-zinc-800"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${p.status === 'open' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <code className="block truncate font-mono text-xs" title={p.id}>
                      {p.id}
                    </code>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                      {p.status === 'open' ? 'connected' : 'connecting…'}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onDisconnect(p.id)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
