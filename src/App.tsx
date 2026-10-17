import { useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { usePeerSync } from './hooks/usePeerSync';
import { useSupabaseSession } from './hooks/useSupabaseSession';
import { useHashRoute, navigateMain } from './hooks/useHashRoute';
import { useWorkspace } from './hooks/useWorkspace';
import { loadWorkspaceId } from './lib/pairing';
import { shortId } from './lib/device';
import { WorkspacePanel } from './components/WorkspacePanel';
import { FocusView } from './components/FocusView';
import { PairView } from './routes/PairView';

// NOTE: QuickDrop (M3 file transfer) is parked: the hook, protocol, tests,
// and component remain in the repo, but the section is not mounted while
// the app stays text-first.

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl lg:max-w-6xl flex-col gap-4 px-4 pb-10 pt-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl tracking-tight lg:text-[21px]" aria-label="SyncMe">
            <span className="font-extrabold text-emerald-600 dark:text-emerald-400">Sync</span><span className="font-light italic text-amber-500 dark:text-amber-400">Me</span>
          </h1>
          <p className="text-xs italic lg:text-base">
            <span className="text-emerald-700 dark:text-emerald-300">One clipboard</span>
            <span className="text-amber-600 dark:text-amber-300"> for all devices.</span>
          </p>
        </div>
      </header>
      <main className="flex flex-col gap-4">{children}</main>
      <Analytics />
    </div>
  );
}

export default function App() {
  const session = useSupabaseSession();
  const sync = usePeerSync();
  const route = useHashRoute();
  const workspace = useWorkspace(session.userId, sync.peerId);
  const [manage, setManage] = useState(false);

  if (route.name === 'pair') {
    return (
      <Shell>
        <PairView
          ws={route.ws}
          token={route.token}
          session={session}
          hasWorkspace={loadWorkspaceId() !== null}
          peerId={sync.peerId}
          onDone={navigateMain}
        />
      </Shell>
    );
  }

  const connected = sync.peerCount > 0;
  const focusDevices = sync.peers
    .filter((p) => p.status === 'open')
    .map((p) => ({
      peerId: p.id,
      name:
        workspace.devices.find(
          (d) => d.peerId === p.id && d.approved && !d.revoked,
        )?.name ?? shortId(p.id),
    }));

  // Connected focus mode: device names + one big text field. Everything
  // else hides behind Manage until explicitly asked for.
  if (connected && !manage) {
    return (
      <Shell>
        <div className="flex justify-end">
          <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs lg:text-base font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            ● online
          </span>
        </div>
        <FocusView
          devices={focusDevices}
          text={sync.text}
          peerCount={sync.peerCount}
          lastRemoteAt={sync.lastRemoteAt}
          onChange={sync.setText}
          onDisconnect={sync.disconnectFrom}
          onManage={() => setManage(true)}
        />
      </Shell>
    );
  }

  // Workspace-only outside focus mode: pairing (QR/link), approvals, and
  // the roster with one-click Connect/Revoke. No manual id box anywhere —
  // QR pairing is the way in, roster buttons the way back.
  return (
    <Shell>
      <div className="flex justify-end">
        {connected ? (
          <button
            type="button"
            onClick={() => setManage(false)}
            className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs lg:text-base font-medium text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-300"
          >
            ● online — back to editor
          </button>
        ) : (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs lg:text-base font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            ● {sync.lifecycle}
          </span>
        )}
      </div>
      <WorkspacePanel
        ws={workspace}
        connectedIds={sync.peers.map((p) => p.id)}
        onConnectPeer={sync.connectTo}
        onDisconnectPeer={sync.disconnectFrom}
        onDisconnectAll={sync.disconnectAll}
      />
    </Shell>
  );
}
