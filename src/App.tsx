import { usePeerSync } from './hooks/usePeerSync';
import { useSupabaseSession } from './hooks/useSupabaseSession';
import { navigateMain, useHashRoute } from './hooks/useHashRoute';
import { loadWorkspaceId } from './lib/pairing';
import { StatusCard } from './components/StatusCard';
import { ConnectPanel } from './components/ConnectPanel';
import { SharedEditor } from './components/SharedEditor';
import { WorkspacePanel } from './components/WorkspacePanel';
import { PairView } from './routes/PairView';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 px-4 pb-10 pt-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">SyncMe</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            OneSpace · your devices, one clipboard · peer-to-peer
          </p>
        </div>
      </header>
      <main className="flex flex-col gap-4">{children}</main>
      <footer className="mt-2 text-center text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
        Text syncs directly between your devices — nothing is stored on any server.
        <br />
        Copy is manual (browsers don’t allow silent clipboard access). No offline delivery in the MVP.
      </footer>
    </div>
  );
}

export default function App() {
  const session = useSupabaseSession();
  const sync = usePeerSync();
  const route = useHashRoute();

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

  return (
    <Shell>
      <div className="flex justify-end">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            sync.lifecycle === 'open'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
          }`}
        >
          {sync.lifecycle === 'open' ? '● online' : `● ${sync.lifecycle}`}
        </span>
      </div>
      <WorkspacePanel
        userId={session.userId}
        peerId={sync.peerId}
        connectedIds={sync.peers.map((p) => p.id)}
        onConnectPeer={sync.connectTo}
      />
      <StatusCard
        session={session}
        peerId={sync.peerId}
        lifecycle={sync.lifecycle}
        lifecycleError={sync.lifecycleError}
        peerCount={sync.peerCount}
      />
      <ConnectPanel
        peers={sync.peers}
        peerId={sync.peerId}
        ready={sync.lifecycle === 'open'}
        onConnect={sync.connectTo}
        onDisconnect={sync.disconnectFrom}
      />
      <SharedEditor
        text={sync.text}
        peerCount={sync.peerCount}
        lastRemoteAt={sync.lastRemoteAt}
        onChange={sync.setText}
      />
    </Shell>
  );
}
