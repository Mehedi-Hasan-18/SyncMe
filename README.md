# SyncMe — One clipboard for all devices.

Stop sending text to yourself. No more pasting links into WhatsApp chats with
yourself, emailing yourself code snippets, or round-tripping a photo through
cloud storage just to move it from your phone to your laptop.

SyncMe gives your phone, laptop, desktop, and tablet **one shared clipboard**:
type on any device and the text is live on all of them — directly,
peer-to-peer, with nothing ever stored on a server.

## The problem it solves

Moving a link, a code snippet, an address, or a note between your own devices
today means borrowing somebody else's infrastructure: a chat app, an email
draft, a cloud drive. That's slow, it litters your apps, and your content sits
on servers you don't control for a job that needs no server at all.

SyncMe removes the middleman. Your devices talk **directly to each other**
over encrypted WebRTC connections:

- **Shared clipboard** — one text field on every device, synced live.
  Simultaneous typing merges instead of overwriting (CRDT under the hood).
- **Private workspaces** — create a workspace, pair each device once with a
  QR code, approve it from a trusted device. Short-lived, single-use codes;
  any device can be revoked at any time.
- **Zero content on servers** — Supabase holds only membership metadata
  (workspaces, devices, hashed pairing codes). Text travels peer-to-peer and
  lives only on your devices.

## How to use it

You need two devices on the same Wi-Fi (e.g. your phone + laptop).

**1. Create the workspace** — open the app, give the workspace a name,
press Create. This device becomes the owner.

**2. Connect your laptop** — press *Pair a new device*, scan the QR code
with your other device (or open the copied invite link), name it, and
request to join. Approve the request on the first device. The code expires
in 5 minutes and works exactly once.

**3. Type anything** — once linked, the app collapses to what matters:
device names on top, one big text field below. Type on either side; it
appears on the other, live. The **Copy** button moves it to the native
clipboard (browsers require this tap — no page can read your clipboard
silently).

**Managing devices** — press **Manage** for the workspace view: connected
devices with one-click Connect, pending approvals, new pairing codes,
per-device **Revoke**, and **Leave**. Revoking drops the link immediately on
both sides and the removed device cannot sneak back in — re-joining needs a
fresh invite and a fresh approval.

**Limits to know** — at least one device must be online to sync (no offline
delivery); approvals need the trusted device's app open; backgrounded mobile
browsers pause connections until foregrounded.

## For developers

**Stack** — Vite + React + TypeScript + Tailwind (static SPA) · Supabase
(Postgres metadata + anonymous auth + RLS + Realtime) · PeerJS (signaling) +
Yjs (CRDT text sync) · Vercel hosting. **Cost to run: $0.**

**Prerequisites** — Node 20+ and a free Supabase project with **Anonymous
sign-in enabled** (Authentication → Providers → Anonymous) plus the two
migrations applied in order (`supabase/migrations/0001_init.sql`,
`0002_pairing.sql`) via `supabase db push` or the SQL editor.

```bash
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev            # LAN-ready (host: true) — open the Network URL on your phone
npm test               # vitest suite (sync, pairing, transfer protocol)
npm run build          # typecheck + production build
```

**Deploy (free)** — push to GitHub, import in Vercel (Vite auto-detected),
add the same `VITE_*` variables under Project → Settings → Environment
Variables, deploy. HTTPS included, which also unlocks clipboard APIs on
mobile. A GitHub Actions cron (`.github/workflows/keepalive.yml`, needs the
`SUPABASE_URL` / `SUPABASE_ANON_KEY` repo secrets) pings Supabase every 3 days
so the free project never pauses.

**Status** — text sync (M1) and secure pairing (M2) are live and validated on
real devices. File transfer (M3 QuickDrop: chunked P2P + SHA-256 +
cancel/retry) is fully implemented and tested but **parked and unmounted**
while the app stays text-first — see `src/components/QuickDrop.tsx`,
`src/hooks/useQuickDrop.ts`, `src/lib/transfer.ts`, `tests/transfer.test.ts`
to bring it back. Full brief and milestones: [`sds.md`](./sds.md).
