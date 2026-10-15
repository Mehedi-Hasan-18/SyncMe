import { useEffect, useState } from 'react';
import type { SessionState } from '../hooks/useSupabaseSession';
import {
  deleteDeviceRow,
  getClient,
  requestJoin,
  saveWorkspaceId,
  subscribeDeviceRow,
} from '../lib/pairing';
import { defaultDeviceName } from '../lib/device';

type Step = 'form' | 'joining' | 'waiting' | 'error' | 'denied';

interface Props {
  ws: string;
  token: string;
  session: SessionState;
  hasWorkspace: boolean;
  peerId: string;
  onDone: () => void;
}

export function PairView({ ws, token, session, hasWorkspace, peerId, onDone }: Props) {
  const [name, setName] = useState(() =>
    typeof navigator === 'undefined' ? 'New device' : defaultDeviceName(navigator.userAgent),
  );
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // Watch our own join request: approval redirects home, denial shows a message.
  useEffect(() => {
    if (step !== 'waiting' || !deviceId) return;
    const sb = getClient();
    if (!sb) {
      setStep('error');
      setError('Supabase is not configured.');
      return;
    }
    return subscribeDeviceRow(sb, deviceId, (row) => {
      if (row.revoked) {
        setStep('denied');
      } else if (row.approved) {
        saveWorkspaceId(row.workspaceId);
        onDone();
      }
    });
  }, [step, deviceId, onDone]);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const sb = getClient();
    if (!sb) {
      setStep('error');
      setError('Supabase is not configured.');
      return;
    }
    if (!session.userId) {
      setStep('error');
      setError('Wait for sign-in to finish, then retry.');
      return;
    }
    setStep('joining');
    setError(null);
    try {
      const id = await requestJoin(
        sb,
        ws,
        token,
        session.userId,
        name.trim() || defaultDeviceName(navigator.userAgent),
        peerId || null,
      );
      setDeviceId(id);
      setStep('waiting');
    } catch (err) {
      setStep('error');
      setError(err instanceof Error ? err.message : 'Join failed.');
    }
  };

  const cancel = async () => {
    const sb = getClient();
    if (sb && deviceId) {
      try {
        await deleteDeviceRow(sb, deviceId);
      } catch {
        // Best effort; the row stays pending until it expires.
      }
    }
    setDeviceId(null);
    setStep('form');
    setError(null);
  };

  const card =
    'rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900';

  return (
    <section aria-label="Join workspace" className={card}>
      <h2 className="text-sm font-normal lg:text-[21px]">Join private workspace</h2>

      {step === 'form' && (
        <form onSubmit={join} className="mt-3">
          <p className="text-xs lg:text-base text-zinc-500 dark:text-zinc-400">
            This invite links the device to workspace{' '}
            <code className="font-mono">{ws.slice(0, 8)}…</code>. An existing device must approve
            you before you can sync.
          </p>
          {hasWorkspace && (
            <p className="mt-2 rounded-lg bg-amber-50 p-2.5 text-xs lg:text-base text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              This device already belongs to a workspace — joining will switch it to the new one.
            </p>
          )}
          {session.status === 'error' && (
            <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2.5 text-xs lg:text-base text-red-700 dark:bg-red-950 dark:text-red-300">
              {session.error}
            </p>
          )}
          <label htmlFor="device-name" className="mt-3 block text-xs lg:text-base font-medium">
            Name this device
          </label>
          <input
            id="device-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm lg:text-base placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700"
          />
          <button
            type="submit"
            disabled={session.status !== 'ready'}
            className="mt-3 w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-semibold lg:text-base text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {session.status === 'ready' ? 'Request to join' : 'Signing in…'}
          </button>
        </form>
      )}

      {step === 'joining' && (
        <p className="mt-3 text-sm lg:text-base text-zinc-500 dark:text-zinc-400">Redeeming invite…</p>
      )}

      {step === 'waiting' && (
        <div className="mt-3">
          <p className="text-sm lg:text-base font-medium">Request sent as “{name}” ✓</p>
          <p className="mt-1 text-xs lg:text-base text-zinc-500 dark:text-zinc-400">
            Open SyncMe on your other device and press <strong>Approve</strong>. This page moves on
            automatically — keep it open.
          </p>
          <div className="mt-3 h-1.5 animate-pulse rounded-full bg-emerald-200 dark:bg-emerald-900" aria-hidden="true" />
          <button
            type="button"
            onClick={cancel}
            className="mt-3 rounded-lg border border-zinc-300 px-3 py-2 text-xs lg:text-base font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancel request
          </button>
        </div>
      )}

      {step === 'denied' && (
        <div className="mt-3">
          <p role="alert" className="rounded-lg bg-red-50 p-2.5 text-xs lg:text-base text-red-700 dark:bg-red-950 dark:text-red-300">
            The request was denied on the other device. Ask the workspace owner for a fresh invite
            code.
          </p>
          <button
            type="button"
            onClick={cancel}
            className="mt-3 rounded-lg border border-zinc-300 px-3 py-2 text-xs lg:text-base font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Try again
          </button>
        </div>
      )}

      {step === 'error' && (
        <div className="mt-3">
          <p role="alert" className="rounded-lg bg-red-50 p-2.5 text-xs lg:text-base text-red-700 dark:bg-red-950 dark:text-red-300">
            {error ?? 'Join failed.'}
          </p>
          <button
            type="button"
            onClick={() => {
              setStep('form');
              setError(null);
            }}
            className="mt-3 rounded-lg border border-zinc-300 px-3 py-2 text-xs lg:text-base font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Back
          </button>
        </div>
      )}
    </section>
  );
}
