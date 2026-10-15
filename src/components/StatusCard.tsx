import type { SessionState } from '../hooks/useSupabaseSession';
import type { PeerLifecycle } from '../hooks/usePeerSync';
import { isSelfHostedSignaling } from '../lib/peer';

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-red-500';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} aria-hidden="true" />;
}

function short(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

interface Props {
  session: SessionState;
  peerId: string;
  lifecycle: PeerLifecycle;
  lifecycleError: string | null;
  peerCount: number;
}

export function StatusCard({ session, peerId, lifecycle, lifecycleError, peerCount }: Props) {
  const peerOk = lifecycle === 'open';
  return (
    <section aria-label="Connection status" className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <ul className="space-y-2 text-sm">
        <li className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Dot ok={session.status === 'ready'} warn={session.status === 'pending'} />
            <span className="font-medium">Supabase</span>
          </span>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {session.status === 'ready' && session.userId
              ? `anon ${short(session.userId)}`
              : session.status === 'pending'
                ? 'signing in…'
                : 'error'}
          </span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Dot ok={peerOk} warn={lifecycle === 'starting' || lifecycle === 'disconnected'} />
            <span className="font-medium">Peer signaling</span>
          </span>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {lifecycle === 'open'
              ? `${isSelfHostedSignaling() ? 'self-hosted' : 'PeerJS cloud'} · ${peerCount} peer${peerCount === 1 ? '' : 's'}`
              : lifecycle}
          </span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span className="font-medium">This device</span>
          <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800" title={peerId}>
            {short(peerId)}
          </span>
        </li>
      </ul>
      {session.error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {session.error}
        </p>
      )}
      {lifecycleError && (
        <p role="alert" className="mt-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Peer error: {lifecycleError}
        </p>
      )}
    </section>
  );
}
