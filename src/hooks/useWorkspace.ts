import { useCallback, useEffect, useState } from 'react';
import {
  approveDevice,
  clearWorkspaceId,
  createWorkspaceRow,
  deleteDeviceRow,
  fetchRoster,
  fetchWorkspace,
  getClient,
  loadWorkspaceId,
  mintPairingToken,
  revokeDevice,
  saveWorkspaceId,
  subscribeRoster,
  touchDevice,
  type RosterDevice,
} from '../lib/pairing';
import { buildPairUrl, defaultDeviceName } from '../lib/device';

export type WorkspaceStatus = 'loading' | 'none' | 'ready' | 'revoked' | 'error';

export interface PairingOffer {
  url: string;
  expiresAt: string;
}

export interface Workspace {
  status: WorkspaceStatus;
  workspaceId: string | null;
  workspaceName: string;
  devices: RosterDevice[];
  own: RosterDevice | null;
  pending: RosterDevice[];
  error: string | null;
  busy: boolean;
  pairing: PairingOffer | null;
  createWorkspace: (name: string) => Promise<string | null>;
  generateToken: () => Promise<string | null>;
  clearPairing: () => void;
  approve: (deviceId: string) => Promise<string | null>;
  deny: (deviceId: string) => Promise<string | null>;
  revoke: (deviceId: string) => Promise<string | null>;
  leave: () => Promise<string | null>;
  refresh: () => Promise<void>;
}

function appBase(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Workspace membership state: creation, roster (via Realtime refetch),
 * pairing-code minting, approval, revocation, and presence heartbeat.
 */
export function useWorkspace(userId: string | null, peerId: string): Workspace {
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => loadWorkspaceId());
  const [workspaceName, setWorkspaceName] = useState('');
  const [devices, setDevices] = useState<RosterDevice[]>([]);
  const [status, setStatus] = useState<WorkspaceStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingOffer | null>(null);

  // Re-read the stored workspace when navigation changes
  // (e.g. returning from #/pair after a successful join).
  useEffect(() => {
    const sync = () => setWorkspaceId(loadWorkspaceId());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const refresh = useCallback(async () => {
    const sb = getClient();
    if (!sb) {
      setStatus('error');
      setError('Supabase is not configured.');
      return;
    }
    const stored = loadWorkspaceId();
    if (!userId) {
      setStatus('loading');
      return;
    }
    if (!stored) {
      setStatus('none');
      setDevices([]);
      setWorkspaceId(null);
      return;
    }
    try {
      const ws = await fetchWorkspace(sb, stored);
      if (!ws) {
        clearWorkspaceId();
        setWorkspaceId(null);
        setStatus('none');
        setDevices([]);
        return;
      }
      const roster = await fetchRoster(sb, stored);
      const own = roster.find((d) => d.userId === userId) ?? null;
      if (!own) {
        clearWorkspaceId();
        setWorkspaceId(null);
        setStatus('none');
        setDevices([]);
        return;
      }
      setWorkspaceName(ws.name);
      setDevices(roster);
      setWorkspaceId(stored);
      if (own.revoked) {
        setStatus('revoked');
        return;
      }
      setStatus('ready');
      setError(null);
      await touchDevice(sb, own.id, peerId || null);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not load workspace.');
    }
  }, [userId, peerId]);

  useEffect(() => {
    refresh();
  }, [refresh, workspaceId]);

  // Live roster: any device change in this workspace refetches.
  useEffect(() => {
    const sb = getClient();
    if (!sb || !userId || !workspaceId || (status !== 'ready' && status !== 'revoked')) {
      return;
    }
    return subscribeRoster(sb, workspaceId, () => {
      refresh();
    });
  }, [userId, workspaceId, status, refresh]);

  // Presence heartbeat while the workspace is active.
  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    const own = devices.find((d) => d.userId === userId) ?? null;
    if (!own) return;
    const timer = setInterval(() => {
      const sb = getClient();
      if (sb) touchDevice(sb, own.id, peerId || null);
    }, 60_000);
    return () => clearInterval(timer);
  }, [status, userId, devices, peerId]);

  const run = useCallback(async (fn: () => Promise<void>): Promise<string | null> => {
    const sb = getClient();
    if (!sb) return 'Supabase is not configured.';
    setBusy(true);
    try {
      await fn();
      await refresh();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Something went wrong.';
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const createWorkspace = useCallback(
    async (name: string): Promise<string | null> => {
      if (!userId) return 'Wait for sign-in to finish, then retry.';
      const clean = name.trim() || 'My workspace';
      let created: string | null = null;
      const err = await run(async () => {
        const sb = getClient();
        if (!sb) throw new Error('Supabase is not configured.');
        created = await createWorkspaceRow(
          sb,
          userId,
          clean,
          defaultDeviceName(navigator.userAgent),
          peerId || null,
        );
        saveWorkspaceId(created);
        setWorkspaceId(created);
        setPairing(null);
      });
      return err;
    },
    [userId, peerId, run],
  );

  const generateToken = useCallback(async (): Promise<string | null> => {
    if (!workspaceId) return 'Create a workspace first.';
    const err = await run(async () => {
      const sb = getClient();
      if (!sb) throw new Error('Supabase is not configured.');
      const minted = await mintPairingToken(sb, workspaceId);
      setPairing({ url: buildPairUrl(appBase(), workspaceId, minted.raw), expiresAt: minted.expiresAt });
    });
    return err;
  }, [workspaceId, run]);

  const clearPairing = useCallback(() => setPairing(null), []);

  const approve = useCallback(
    (deviceId: string) =>
      run(async () => {
        const sb = getClient();
        if (!sb) throw new Error('Supabase is not configured.');
        await approveDevice(sb, deviceId);
      }),
    [run],
  );

  const deny = useCallback(
    (deviceId: string) =>
      run(async () => {
        const sb = getClient();
        if (!sb) throw new Error('Supabase is not configured.');
        await revokeDevice(sb, deviceId);
      }),
    [run],
  );

  const revoke = deny;

  const leave = useCallback(async (): Promise<string | null> => {
    const own = devices.find((d) => d.userId === userId) ?? null;
    const err = await run(async () => {
      const sb = getClient();
      if (!sb) throw new Error('Supabase is not configured.');
      if (own) await deleteDeviceRow(sb, own.id);
      clearWorkspaceId();
      setWorkspaceId(null);
      setDevices([]);
      setPairing(null);
      setStatus('none');
    });
    return err;
  }, [devices, userId, run]);

  const own = devices.find((d) => d.userId === userId) ?? null;
  const pending = devices.filter((d) => !d.approved && !d.revoked && d.id !== own?.id);

  return {
    status,
    workspaceId,
    workspaceName,
    devices,
    own,
    pending,
    error,
    busy,
    pairing,
    createWorkspace,
    generateToken,
    clearPairing,
    approve,
    deny,
    revoke,
    leave,
    refresh,
  };
}
