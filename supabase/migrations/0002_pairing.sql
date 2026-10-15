-- SyncMe M2: pairing approval + peer identity + Realtime.
--
-- Apply AFTER 0001_init.sql with: supabase db push
-- (or paste into the Supabase SQL editor). Safe to run once; the
-- publication block is idempotent.

-- Device approval + peer identity ------------------------------------------------
-- `approved` gates membership: only approved, non-revoked devices count as
-- workspace members. `peer_id` lets member devices one-click connect without
-- retyping ids (it is routing metadata, not content).

alter table public.devices add column if not exists approved boolean not null default false;
alter table public.devices add column if not exists peer_id text;

-- Membership now requires approval. (The workspace creator inserts its own
-- device row with approved = true, so bootstrapping is unaffected.)

create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.devices
    where workspace_id = ws_id
      and user_id = auth.uid()
      and approved = true
      and revoked = false
  );
$$;

-- Approval / revocation RPCs ------------------------------------------------------
-- Column-level updates can't be constrained by RLS, so approval and
-- revocation go through these SECURITY DEFINER functions. Only an approved
-- member or the owner of the device's workspace may call them (plus the
-- device owner themselves for self-revocation / leaving).

create or replace function public.approve_device(p_device_id uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.devices where id = p_device_id;
  if v_ws is null then
    return false;
  end if;
  if not (public.is_workspace_member(v_ws) or public.is_workspace_owner(v_ws)) then
    return false;
  end if;
  update public.devices set approved = true, revoked = false where id = p_device_id;
  return true;
end;
$$;

create or replace function public.revoke_device(p_device_id uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.devices where id = p_device_id;
  if v_ws is null then
    return false;
  end if;
  if not (
    public.is_workspace_member(v_ws)
    or public.is_workspace_owner(v_ws)
    or exists (select 1 from public.devices where id = p_device_id and user_id = auth.uid())
  ) then
    return false;
  end if;
  update public.devices set revoked = true where id = p_device_id;
  return true;
end;
$$;

-- Realtime (join-request approvals + roster updates) -------------------------------
-- UPDATE payloads need a full replica identity; the publication additions
-- make INSERT/UPDATE/DELETE events visible to subscribed clients
-- (RLS still filters which rows each device receives).

alter table public.devices replica identity full;
alter table public.pairing_tokens replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'devices'
  ) then
    alter publication supabase_realtime add table public.devices;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'pairing_tokens'
  ) then
    alter publication supabase_realtime add table public.pairing_tokens;
  end if;
end;
$$;
