import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import { randomHex, sha256Hex, tokenExpiryIso } from './device';

const WORKSPACE_STORAGE_KEY = 'syncme-workspace-id';
export const PAIRING_TOKEN_TTL_MINUTES = 5;

export interface RosterDevice {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  peerId: string | null;
  approved: boolean;
  revoked: boolean;
  lastSeen: string;
}

interface DeviceRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  peer_id: string | null;
  approved: boolean;
  revoked: boolean;
  last_seen: string;
}

function toRoster(row: DeviceRow): RosterDevice {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    name: row.name,
    peerId: row.peer_id,
    approved: row.approved,
    revoked: row.revoked,
    lastSeen: row.last_seen,
  };
}

function fail(message: string, detail: unknown): Error {
  const extra =
    detail && typeof detail === 'object' && 'message' in detail
      ? `: ${(detail as { message: string }).message}`
      : '';
  return new Error(`${message}${extra}`);
}

// Stored workspace ---------------------------------------------------------------

export function loadWorkspaceId(): string | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return raw && /^[0-9a-fA-F-]{8,64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveWorkspaceId(id: string): void {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
  } catch {
    // Non-fatal: the workspace just won't survive a reload.
  }
}

export function clearWorkspaceId(): void {
  try {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // Non-fatal.
  }
}

// Workspace + roster reads ----------------------------------------------------------

export async function fetchWorkspace(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await sb
    .from('workspaces')
    .select('id,name')
    .eq('id', workspaceId)
    .single();
  if (error) {
    // PGRST116 = no rows (deleted, or no access under RLS).
    if (error.code === 'PGRST116') return null;
    throw fail('Could not load workspace', error);
  }
  return data as { id: string; name: string };
}

export async function fetchRoster(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<RosterDevice[]> {
  const { data, error } = await sb
    .from('devices')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw fail('Could not load devices', error);
  return ((data ?? []) as DeviceRow[]).map(toRoster);
}

// Workspace creation (first device) --------------------------------------------------

/** Creates a workspace and registers this device as its approved owner-member. */
export async function createWorkspaceRow(
  sb: SupabaseClient,
  userId: string,
  workspaceName: string,
  deviceName: string,
  peerId: string | null,
): Promise<string> {
  const { data: ws, error: wsError } = await sb
    .from('workspaces')
    .insert({ name: workspaceName, created_by: userId })
    .select('id')
    .single();
  if (wsError || !ws) throw fail('Could not create workspace', wsError);
  const workspaceId = (ws as { id: string }).id;

  const { error: devError } = await sb.from('devices').insert({
    workspace_id: workspaceId,
    user_id: userId,
    name: deviceName,
    peer_id: peerId,
    approved: true,
  });
  if (devError) throw fail('Could not register this device', devError);
  return workspaceId;
}

// Pairing tokens ------------------------------------------------------------------------

export interface MintedToken {
  raw: string;
  expiresAt: string;
}

/** Mints a short-lived, single-use token. Only its SHA-256 hash is stored. */
export async function mintPairingToken(
  sb: SupabaseClient,
  workspaceId: string,
  ttlMinutes: number = PAIRING_TOKEN_TTL_MINUTES,
): Promise<MintedToken> {
  const raw = randomHex(32);
  const tokenHash = await sha256Hex(raw);
  const { error } = await sb.from('pairing_tokens').insert({
    workspace_id: workspaceId,
    token_hash: tokenHash,
    expires_at: tokenExpiryIso(ttlMinutes),
    status: 'pending',
  });
  if (error) throw fail('Could not create pairing code', error);
  return { raw, expiresAt: tokenExpiryIso(ttlMinutes) };
}

// Join (new device) -----------------------------------------------------------------------

/**
 * Redeems a pairing token (atomically single-use) and files a join request
 * as an *unapproved* device. The requester then waits for an existing
 * member to approve via `approve_device`.
 */
export async function requestJoin(
  sb: SupabaseClient,
  expectedWorkspaceId: string,
  rawToken: string,
  userId: string,
  deviceName: string,
  peerId: string | null,
): Promise<string> {
  const tokenHash = await sha256Hex(rawToken.trim());
  const { data: workspaceId, error: rpcError } = await sb.rpc(
    'consume_pairing_token',
    { p_token_hash: tokenHash },
  );
  if (rpcError) throw fail('Pairing failed', rpcError);
  if (!workspaceId || workspaceId !== expectedWorkspaceId) {
    throw new Error('This code is invalid, expired, or already used. Ask for a fresh code.');
  }
  // Re-joining after a revoke: drop our own stale revoked rows first so the
  // roster doesn't accumulate ghosts (RLS permits deleting our own rows).
  await sb
    .from('devices')
    .delete()
    .eq('workspace_id', workspaceId as string)
    .eq('user_id', userId)
    .eq('revoked', true);
  const { data: row, error: insertError } = await sb
    .from('devices')
    .insert({
      workspace_id: workspaceId as string,
      user_id: userId,
      name: deviceName,
      peer_id: peerId,
      approved: false,
    })
    .select('id')
    .single();
  if (insertError || !row) throw fail('Could not file the join request', insertError);
  return (row as { id: string }).id;
}

// Approval / revocation (existing members) --------------------------------------------------

async function callDeviceRpc(
  sb: SupabaseClient,
  fn: 'approve_device' | 'revoke_device',
  deviceId: string,
  failureMessage: string,
): Promise<void> {
  const { data, error } = await sb.rpc(fn, { p_device_id: deviceId });
  if (error) throw fail(failureMessage, error);
  if (data !== true) throw new Error(`${failureMessage} — are you still a member?`);
}

export function approveDevice(sb: SupabaseClient, deviceId: string): Promise<void> {
  return callDeviceRpc(sb, 'approve_device', deviceId, 'Approval failed');
}

export function revokeDevice(sb: SupabaseClient, deviceId: string): Promise<void> {
  return callDeviceRpc(sb, 'revoke_device', deviceId, 'Revocation failed');
}

/** Deletes a device row outright (leaving, or cancelling your own request). */
export async function deleteDeviceRow(sb: SupabaseClient, deviceId: string): Promise<void> {
  const { error } = await sb.from('devices').delete().eq('id', deviceId);
  if (error) throw fail('Could not remove the device', error);
}

/** Best-effort presence heartbeat. Never throws. */
export async function touchDevice(
  sb: SupabaseClient,
  deviceId: string,
  peerId: string | null,
): Promise<void> {
  try {
    await sb
      .from('devices')
      .update({ peer_id: peerId, last_seen: new Date().toISOString() })
      .eq('id', deviceId);
  } catch {
    // Presence is advisory; a failed heartbeat must never break the app.
  }
}

// Realtime ------------------------------------------------------------------------------

export function getClient(): SupabaseClient | null {
  return getSupabase();
}

/** Refetch hook for any INSERT/UPDATE/DELETE on a workspace's devices. */
export function subscribeRoster(
  sb: SupabaseClient,
  workspaceId: string,
  onChange: () => void,
): () => void {
  const channel = sb
    .channel(`devices:${workspaceId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'devices',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      onChange,
    )
    .subscribe();
  return () => {
    sb.removeChannel(channel);
  };
}

/** Watch one device row (join-request waiting room, revocation detection). */
export function subscribeDeviceRow(
  sb: SupabaseClient,
  deviceId: string,
  onChange: (row: RosterDevice) => void,
): () => void {
  const channel = sb
    .channel(`device:${deviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'devices',
        filter: `id=eq.${deviceId}`,
      },
      (payload) => {
        onChange(toRoster(payload.new as DeviceRow));
      },
    )
    .subscribe();
  return () => {
    sb.removeChannel(channel);
  };
}
