import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Workspace } from '../hooks/useWorkspace';
import { formatCountdown, msUntilExpiry, shortId } from '../lib/device';

function useNow(stepMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(timer);
  }, [stepMs, active]);
  return now;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'active now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

interface Props {
  ws: Workspace;
  connectedIds: string[];
  onConnectPeer: (peerId: string) => string | null;
  onDisconnectPeer: (peerId: string) => void;
  onDisconnectAll: () => void;
}

export function WorkspacePanel({ ws, connectedIds, onConnectPeer, onDisconnectPeer, onDisconnectAll }: Props) {
  const [nameInput, setNameInput] = useState('My workspace');
  const [actionError, setActionError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const now = useNow(1000, ws.pairing !== null);

  useEffect(() => {
    if (!ws.pairing) return;
    if (msUntilExpiry(ws.pairing.expiresAt, now) <= 0) ws.clearPairing();
  }, [now, ws]);

  const mutate = async (fn: () => Promise<string | null>) => {
    setActionError(null);
    const err = await fn();
    if (err) setActionError(err);
  };

  // Revoking/denying also severs the live link immediately (the roster
  // effect below covers revocations issued by *other* members).
  const severAnd = (
    deviceId: string,
    devicePeerId: string | null,
    action: (id: string) => Promise<string | null>,
  ) =>
    mutate(async () => {
      const err = await action(deviceId);
      if (!err && devicePeerId) onDisconnectPeer(devicePeerId);
      return err;
    });

  // Revocation is enforced on the data plane too: sever live links to
  // revoked devices so neither side can keep syncing (or auto-redial).
  useEffect(() => {
    for (const d of ws.devices) {
      if (d.revoked && d.peerId && connectedIds.includes(d.peerId)) {
        onDisconnectPeer(d.peerId);
      }
    }
  }, [ws.devices, connectedIds, onDisconnectPeer]);

  // If our own access was revoked, drop everything and forget all devices
  // so this client can neither sync nor auto-reconnect back in.
  useEffect(() => {
    if (ws.status === 'revoked') onDisconnectAll();
  }, [ws.status, onDisconnectAll]);

  const copyLink = async () => {
    if (!ws.pairing) return;
    try {
      await navigator.clipboard.writeText(ws.pairing.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError('Copy failed — long-press the link and copy manually.');
    }
  };

  const card =
    'rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900';

  if (ws.status === 'loading') {
    return (
      <section aria-label="Workspace" className={card}>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading workspace…</p>
      </section>
    );
  }

  if (ws.status === 'error') {
    return (
      <section aria-label="Workspace" className={card}>
        <h2 className="text-sm font-semibold">Private workspace</h2>
        <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {ws.error ?? 'Could not load workspace.'}
        </p>
        <button
          type="button"
          onClick={() => ws.refresh()}
          className="mt-3 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Retry
        </button>
      </section>
    );
  }

  if (ws.status === 'revoked') {
    return (
      <section aria-label="Workspace" className={card}>
        <h2 className="text-sm font-semibold">Private workspace</h2>
        <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          This device’s access was revoked by another device. Your text and files were never
          stored anywhere — only this device’s membership was removed.
        </p>
        <button
          type="button"
          onClick={() => mutate(() => ws.leave())}
          className="mt-3 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Start a new workspace
        </button>
        {actionError && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{actionError}</p>
        )}
      </section>
    );
  }

  if (ws.status === 'none' || !ws.workspaceId) {
    return (
      <section aria-label="Workspace" className={card}>
        <h2 className="text-sm font-semibold">Private workspace</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Create a private workspace on this device, then pair your other devices with a QR code.
          Only membership metadata is stored — never your text or files.
        </p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            mutate(() => ws.createWorkspace(nameInput));
          }}
        >
          <label htmlFor="ws-name" className="sr-only">Workspace name</label>
          <input
            id="ws-name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Workspace name"
            maxLength={60}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700"
          />
          <button
            type="submit"
            disabled={ws.busy}
            className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {ws.busy ? 'Creating…' : 'Create'}
          </button>
        </form>
        {actionError && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{actionError}</p>
        )}
      </section>
    );
  }

  const remaining = ws.pairing ? msUntilExpiry(ws.pairing.expiresAt, now) : 0;

  return (
    <section aria-label="Workspace" className={card}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-semibold" title={ws.workspaceName}>
          {ws.workspaceName}
        </h2>
        <button
          type="button"
          onClick={() => {
            if (confirmLeave) {
              setConfirmLeave(false);
              mutate(() => ws.leave());
            } else {
              setConfirmLeave(true);
              setTimeout(() => setConfirmLeave(false), 5000);
            }
          }}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          {confirmLeave ? 'Click again to leave' : 'Leave'}
        </button>
      </div>

      {ws.pending.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <h3 className="text-xs font-semibold text-amber-900 dark:text-amber-100">
            {ws.pending.length} device{ws.pending.length === 1 ? '' : 's'} waiting for approval
          </h3>
          <ul className="mt-2 space-y-2">
            {ws.pending.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{d.name}</span>
                  <span className="block font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                    requested just now · id {shortId(d.userId)}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    disabled={ws.busy}
                    onClick={() => mutate(() => ws.approve(d.id))}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={ws.busy}
                    onClick={() => severAnd(d.id, d.peerId, ws.deny)}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-white dark:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    Deny
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          Devices ({ws.devices.filter((d) => d.approved && !d.revoked).length})
        </h3>
        <ul className="mt-1.5 space-y-1.5">
          {ws.devices
            .filter((d) => d.approved && !d.revoked)
            .map((d) => {
              const isSelf = d.id === ws.own?.id;
              const connected = d.peerId !== null && connectedIds.includes(d.peerId);
              return (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-zinc-100 px-2.5 py-1.5 dark:bg-zinc-800"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">
                      {d.name} {isSelf && <span className="text-zinc-400">(this device)</span>}
                    </span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                      {d.peerId ? timeAgo(d.lastSeen) : 'no peer id yet'}
                    </span>
                  </span>
                  {!isSelf && (
                    <span className="flex shrink-0 items-center gap-1.5">
                      {d.peerId &&
                        (connected ? (
                          <span className="rounded-md px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400">
                            Connected ✓
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              const err = d.peerId ? onConnectPeer(d.peerId) : 'No peer id yet.';
                              setConnectError(err);
                              if (!err) setTimeout(() => setConnectError(null), 4000);
                            }}
                            className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
                          >
                            Connect
                          </button>
                        ))}
                      <button
                        type="button"
                        disabled={ws.busy}
                        onClick={() => severAnd(d.id, d.peerId, ws.revoke)}
                        className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        Revoke
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
        {connectError && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{connectError}</p>
        )}
      </div>

      <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        {!ws.pairing ? (
          <button
            type="button"
            disabled={ws.busy}
            onClick={() => mutate(() => ws.generateToken())}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {ws.busy ? 'Generating…' : 'Pair a new device (show QR)'}
          </button>
        ) : (
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold">Scan to pair — expires in {formatCountdown(remaining)}</h3>
              <button
                type="button"
                onClick={ws.clearPairing}
                className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Hide
              </button>
            </div>
            <div className="mt-2 flex justify-center rounded-xl bg-white p-4">
              <QRCodeSVG value={ws.pairing.url} size={200} aria-label="Pairing QR code" />
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              {ws.pairing.url}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={copyLink}
                className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {copied ? 'Link copied ✓' : 'Copy invite link'}
              </button>
              <button
                type="button"
                disabled={ws.busy}
                onClick={() => mutate(() => ws.generateToken())}
                className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                New code
              </button>
            </div>
            <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              Single-use and expires in 5 minutes. After scanning, approve the request on this
              device — the new device waits until you do.
            </p>
          </div>
        )}
      </div>

      {actionError && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{actionError}</p>
      )}
    </section>
  );
}
