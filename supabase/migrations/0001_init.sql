-- SyncMe MVP metadata schema.
-- Stores ONLY session/authorization metadata. Shared text and file bytes
-- must never be persisted here (they travel peer-to-peer over WebRTC).
--
-- Apply with: supabase db push   (or paste into the Supabase SQL editor)

create extension if not exists "pgcrypto";

-- Workspaces ---------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My workspace',
  created_by uuid,
  created_at timestamptz not null default now()
);

-- Devices ------------------------------------------------------------------

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  name text not null default 'Unnamed device',
  public_key text,
  last_seen timestamptz not null default now(),
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index devices_workspace_idx on public.devices(workspace_id);
create index devices_user_idx on public.devices(user_id);

-- Pairing tokens (only the SHA-256 hash is stored; the raw token is shown
-- once inside the QR code and never persisted) ------------------------------

create table public.pairing_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'consumed', 'expired', 'revoked')),
  created_at timestamptz not null default now()
);
create index pairing_tokens_workspace_idx on public.pairing_tokens(workspace_id);

-- Row-Level Security ---------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.devices enable row level security;
alter table public.pairing_tokens enable row level security;

-- SECURITY DEFINER helpers bypass RLS internally so membership checks don't
-- recurse through policies. They only ever inspect metadata.

create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.devices
    where workspace_id = ws_id
      and user_id = auth.uid()
      and revoked = false
  );
$$;

create or replace function public.is_workspace_owner(ws_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces
    where id = ws_id
      and created_by = auth.uid()
  );
$$;

-- Workspaces: any signed-in device (incl. anonymous) can create one; only
-- owners and member devices can see or change it.

create policy "authenticated can create workspaces"
  on public.workspaces for insert to authenticated with check (true);

create policy "owners and members can read workspaces"
  on public.workspaces for select to authenticated
  using (created_by = auth.uid() or public.is_workspace_member(id));

create policy "owners can update workspaces"
  on public.workspaces for update to authenticated
  using (created_by = auth.uid());

create policy "owners can delete workspaces"
  on public.workspaces for delete to authenticated
  using (created_by = auth.uid());

-- Devices: a device registers itself (user_id must equal its own auth.uid);
-- workspace members can list peers; owners manage revocation.

create policy "devices can self-register"
  on public.devices for insert to authenticated
  with check (user_id = auth.uid());

create policy "owners and members can read devices"
  on public.devices for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_workspace_member(workspace_id)
    or public.is_workspace_owner(workspace_id)
  );

create policy "devices can update themselves, owners manage"
  on public.devices for update to authenticated
  using (user_id = auth.uid() or public.is_workspace_owner(workspace_id));

create policy "devices can remove themselves, owners remove any"
  on public.devices for delete to authenticated
  using (user_id = auth.uid() or public.is_workspace_owner(workspace_id));

-- Pairing tokens: only member devices / owners of the workspace.

create policy "members can create pairing tokens"
  on public.pairing_tokens for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    or public.is_workspace_owner(workspace_id)
  );

create policy "members can read pairing tokens"
  on public.pairing_tokens for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    or public.is_workspace_owner(workspace_id)
  );

create policy "members can update pairing tokens"
  on public.pairing_tokens for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    or public.is_workspace_owner(workspace_id)
  );

create policy "owners can delete pairing tokens"
  on public.pairing_tokens for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

-- Atomic single-use consume: returns the workspace id for a valid pending
-- token and flips it to consumed in the same statement, so a token can
-- never be redeemed twice even under concurrent requests.

create or replace function public.consume_pairing_token(p_token_hash text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_workspace_id uuid;
begin
  select id, workspace_id into v_id, v_workspace_id
  from public.pairing_tokens
  where token_hash = p_token_hash
    and status = 'pending'
    and expires_at > now()
  for update;

  if v_id is null then
    return null;
  end if;

  update public.pairing_tokens set status = 'consumed' where id = v_id;
  return v_workspace_id;
end;
$$;
