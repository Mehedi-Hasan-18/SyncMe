# SyncMe — OneSpace (MVP)

A cross-device workspace: one shared clipboard plus file drops across your own
phone, laptop, desktop, and tablet. Text and files travel **peer-to-peer over
WebRTC** — no content is ever stored on any server.

- **Frontend:** Vite + React + TypeScript + Tailwind (static SPA)
- **Metadata only:** Supabase (Postgres + anonymous auth + RLS) — workspaces,
  devices, pairing tokens. Never text or file bytes.
- **Signaling:** PeerJS cloud (free tier); self-host later via `VITE_PEER_*`.
- **Text sync:** Yjs CRDT over the DataConnection (concurrent edits merge).
- **Files:** QuickDrop in M3 (chunked DataChannel + SHA-256).
- **Hosting:** Vercel Hobby. **Cost: $0/month.**

See [`sds.md`](./sds.md) for the full brief, architecture, and milestones.

## Prerequisites

- Node 20+
- A free [Supabase](https://supabase.com) project with **Anonymous sign-in
  enabled** (Authentication → Providers → Anonymous → on)
- Migrations applied in order (via `supabase db push` or the SQL editor):
  1. [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql) —
     workspaces, devices, pairing tokens + RLS
  2. [`supabase/migrations/0002_pairing.sql`](./supabase/migrations/0002_pairing.sql) —
     approval flag, peer ids, approve/revoke RPCs, Realtime publication

## Run locally

```bash
npm install
cp .env.example .env   # then fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev
```

`vite.config.ts` sets `server.host: true`, so the dev server listens on your
LAN — open the printed `http://<your-lan-ip>:5173` URL on your phone to test
two real devices on the same Wi-Fi.

Useful scripts:

```bash
npm run build   # typecheck + production build
npm test        # vitest suite (sync protocol, concurrent-edit merge, …)
npm run lint    # typecheck only
```

## Two-device test (M1 acceptance)

1. `npm run dev` on your laptop; open the URL on the laptop.
2. Open the LAN URL on your phone (same Wi-Fi).
3. On one device, press **Copy my id**, paste it into the other device's
   **Connect** box, and press Connect.
4. Type in the shared editor on either side — text appears live on the other.
5. Type **simultaneously** on both — both contributions survive (CRDT merge).
6. Reload either page — it auto-reconnects and re-syncs the full state.

## Pairing test (M2 acceptance)

Requires migration `0002_pairing.sql` (Realtime is enabled by the migration;
verify in Supabase → Database → Replication that `devices` and
`pairing_tokens` are listed if approvals don't arrive live).

1. On the laptop: **Create** a private workspace.
2. Press **Pair a new device** — a QR code + invite link appear (5:00 countdown).
3. On the phone: scan the QR (or open the copied link), name the device,
   **Request to join**. The phone shows a waiting screen.
4. On the laptop: the request appears in amber — press **Approve**. The phone
   joins automatically and appears in the device list.
5. Negative paths: let a code expire (or press **New code**) and join with the
   old link → rejected. Request again and press **Deny** → phone shows denial.
   Reuse the same link twice → second attempt rejected (single-use).
6. **Revoke**: on either device, revoke the other — it drops from the list and
   the revoked device shows an "access revoked" banner. **Connect** buttons on
   the roster link members with one click, no id typing.
7. Check Supabase → Table Editor: `workspaces` has 1 row, `devices` has one
   row per device (approved flags), `pairing_tokens` holds only hashes —
   never text or file bytes.

## Deploy to Vercel (free)

1. Push this repo to GitHub.
2. Vercel → Add New → Project → Import the repo (Vite is auto-detected).
3. Add the **same** `VITE_*` variables from `.env` in
   Project → Settings → Environment Variables.
4. Deploy — you get HTTPS on `*.vercel.app`, which browsers require for
   clipboard and camera/QR features.

## Keep-alive

The workflow in [`.github/workflows/keepalive.yml`](./.github/workflows/keepalive.yml)
pings Supabase every 3 days so the free project never pauses. Add the
`SUPABASE_URL` and `SUPABASE_ANON_KEY` repo secrets to enable it.

## Privacy model

- Supabase holds only metadata: workspaces, device registrations, hashed
  pairing tokens. Row-Level Security isolates workspaces (`auth.uid()`).
- Pairing tokens are stored as hashes and consumed atomically (single-use).
- Clipboard access is always user-triggered; no silent monitoring.
- No offline delivery in the MVP: at least one peer must be online to sync.
