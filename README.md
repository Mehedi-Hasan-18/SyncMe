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
- The migration in [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql)
  applied (via `supabase db push` or the SQL editor)

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
6. Reload one page — reopening the connection re-syncs the full state.

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
