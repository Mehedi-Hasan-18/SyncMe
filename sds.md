# Project Brief: SyncMe

## Product Vision

Build OneSpace, a web-based cross-device workspace that lets users use their phone, desktop, laptop, and tablet as one connected environment.

The goal is to eliminate the need to send text, links, code snippets, images, and files to oneself through WhatsApp, email, or cloud-storage workflows.

OneSpace is NOT a cloud drive. Its primary purpose is instant synchronization and direct transfer between a user's connected devices.

## Core MVP Features

### 1. Shared Clipboard
- Provide a shared text editor available on all connected devices.
- Users can explicitly share text and links into the workspace.
- Changes should appear on other connected devices in real time.
- Support copying the shared text to the native clipboard through a user action.
- Prevent silent overwriting when simultaneous edits occur.
- Do not claim that a website can automatically monitor the native clipboard in all browsers.

### 2. QuickDrop
- Allow users to select one or more files and send them to another connected device.
- Support common files such as images, PDFs, documents, and code files.
- Display filename, size, progress, and transfer status.
- Support cancellation, error handling, and retry where possible.
- Use chunked WebRTC data transfer with backpressure and file integrity verification.
- Do not persist user files on application servers.

### 3. Secure Device Pairing
- Allow a user to create a private workspace.
- Display a QR code for pairing another device.
- Use short-lived, single-use pairing tokens.
- Require authorization before a device joins.
- Support multiple connected devices.
- Allow users to revoke access to a connected device.

### 4. Real-Time Multi-Device Synchronization
- Maintain a consistent shared text state across connected devices.
- Handle device disconnections and reconnections.
- Define a clear conflict-resolution strategy.
- Make connection status visible.
- Do not promise offline delivery in the MVP.

## Data Ownership and Privacy

The product must not permanently store user text or files on its servers.

Use direct peer-to-peer WebRTC connections whenever possible. A lightweight signaling service may coordinate connections and authenticate sessions.

Use STUN/TURN infrastructure when required. Configure relay infrastructure without persistent payload storage and avoid logging content.

Store only the minimum necessary session and authorization metadata. Avoid persisting shared text, file contents, or file payloads in a database.

Document the limitations of ephemeral synchronization and browser clipboard access.

## Technology Stack (Finalized for MVP)

Chosen for **maximum simplicity, minimal dependencies, and a fully free deployment**. This supersedes the earlier Next.js suggestion, since the app sits behind a pairing screen and needs no SSR or SEO.

- **Vite + React + TypeScript** — static single-page app (lighter and faster to ship than Next.js)
- **Tailwind CSS** — styling
- **Supabase** — managed Postgres for minimal metadata only, plus anonymous authentication, Row-Level Security for workspace isolation, and Realtime for the pairing-approval flow
- **PeerJS** — WebRTC signaling + data connections (PeerJS cloud for now; self-host later)
- **Yjs** — CRDT shared-text state (automatic conflict merge, no silent overwriting)
- **WebRTC DataChannels** — carrier for both text updates and file transfers (peer-to-peer)
- **STUN/TURN** — Google public STUN + Metered Open Relay (free TURN), injected via PeerJS `config.iceServers`
- **Web Crypto (`crypto.subtle`)** — SHA-256 file integrity verification

Do not add unnecessary services or dependencies. Keep the free-tier services swappable via environment variables so paid/self-hosted options can be introduced later without a rewrite.

## Deployment (Zero-Cost MVP)

The MVP must ship for **$0/month**. Because text and files are peer-to-peer, there is no bandwidth or storage cost for content; only signaling, TURN relay, and metadata use external services, all of which have free tiers.

| Need | Free service | Cost |
| --- | --- | --- |
| Frontend hosting | Vercel Hobby (`*.vercel.app`, HTTPS included) | $0 |
| Metadata DB + auth + realtime | Supabase free tier | $0 |
| WebRTC signaling | PeerJS cloud (`0.peerjs.com`) | $0 |
| STUN | Google public STUN | $0 |
| TURN relay fallback | Metered Open Relay (public free TURN) | $0 |

**Keep-alive:** a GitHub Actions cron pings the Supabase project every ~3 days so the free project never auto-pauses.

**Free-tier caveats:**
- Supabase free projects pause after ~7 days of inactivity — mitigated by the keep-alive cron.
- PeerJS cloud is best-effort (no SLA) — acceptable for the MVP; self-host `peer` later.
- Open Relay TURN is shared and best-effort — same-Wi-Fi demos connect via STUN alone, so this only matters on strict/mobile networks.

All external URLs, keys, and ICE configuration are read from environment variables so migration to paid or self-hosted infrastructure is a config change, not a rewrite.

## Main Screens

1. Main workspace: shared editor, QuickDrop, incoming transfers, connected devices.
2. Pairing screen: QR code, approval, connection state.
3. Transfer activity: progress, completed transfers, errors, retry, cancellation.
4. Minimal settings: device management and revoke access.

The interface must be responsive, mobile-first, accessible, and easy to use.

## Non-Functional Requirements

- HTTPS everywhere.
- Secure authentication and authorization.
- Workspace isolation.
- Expiring pairing tokens.
- Safe file-transfer limits and validation.
- Clear loading, empty, offline, and error states.
- No content payloads in application logs.
- No unauthorized file access.
- Tests for synchronization, pairing, transfer failures, and concurrent editing.

## Implementation Instructions

Before writing code:

1. Inspect the existing repository and identify the current framework and tooling.
2. Produce an architecture proposal and explain how WebRTC, signaling, pairing, and synchronization work together.
3. Identify technical limitations, security risks, and deployment costs.
4. Propose the folder structure, data flow, key components, and testing strategy.
5. Break implementation into small milestones with acceptance criteria.
6. Wait for approval before implementing the complete project.

Implement incrementally. Validate each milestone before proceeding.

The first milestone should demonstrate shared text synchronization between two real devices. Next implement secure pairing, then peer-to-peer file transfers.

Do not add paid plans, teams, AI features, cloud-drive functionality, or native apps to the initial MVP.

## Approved Architecture

### How the pieces work together

1. **Identity & metadata (Supabase).** On first load, each device signs in anonymously and receives a stable identity. Only metadata is stored: workspaces, devices, and pairing tokens. Row-Level Security guarantees a device can only touch rows for workspaces it belongs to.
2. **Signaling (PeerJS).** PeerJS handles the WebRTC handshake (SDP offer/answer + ICE) and presence through its signaling server. No content passes through it.
3. **Connection (WebRTC DataChannels).** Once signaled, devices open direct peer-to-peer DataChannels. All payloads — text and files — travel over these channels.
4. **Shared text (Yjs).** The shared editor is a Yjs CRDT document. Its updates are exchanged over the DataChannel, so simultaneous edits converge automatically instead of overwriting. An awareness indicator shows which devices are editing.
5. **File transfer (QuickDrop).** Files are chunked (~16 KB) over a DataChannel with backpressure and flow control, verified with SHA-256, and never persisted on any server.
6. **Pairing.** The first device creates a workspace and mints a short-lived, single-use, hashed pairing token. A QR code carries the pairing URL. The new device presents its identity, the existing trusted device approves via Supabase Realtime, and the workspace secret is handed over peer-to-peer. Devices can be revoked.

### Data flow

```text
Device A ── WebSocket/PeerJS (signaling + ICE + presence) ── Device B
   └────────────── WebRTC DataChannel (P2P payloads) ──────────────┘
        text: Yjs updates        files: chunked frames + SHA-256

Servers store ONLY metadata: workspaces, device public keys/status, hashed pairing tokens.
TURN relays encrypted packets with no storage and no content logging.
```

### Metadata schema (the only server-side data)

- `workspaces(id, name, created_at)`
- `devices(id, workspace_id, user_id, name, public_key, last_seen, revoked)`
- `pairing_tokens(id, workspace_id, token_hash, expires_at, status)` + an atomic single-use consume function

No shared text, file contents, or file payloads are ever stored.

### Folder structure

```text
syncme/
  index.html  vite.config.ts  tailwind.config.ts
  src/
    main.tsx  App.tsx
    routes/       # workspace, pair, activity, settings
    components/   # editor, dropzone, transfer-list, device-list, qr
    lib/          # supabase.ts, peer.ts, sync.ts, transfer.ts, pairing.ts
    hooks/        # usePeers, useTransfer, useYjsDoc
  supabase/migrations/   # workspaces, devices, pairing_tokens + RLS + consume RPC
  .github/workflows/     # keep-alive ping
  tests/
```

### Key decisions log

- Anonymous, device-first identity — no accounts, no PII beyond device metadata.
- Single static SPA (Vite) rather than Next.js — no SSR/SEO needed.
- Supabase free tier for metadata + auth + realtime rather than a self-run database.
- PeerJS for connections — avoids hand-writing SDP/ICE negotiation.
- Yjs for text sync — makes "prevent silent overwriting" a property of the data model.
- Zero-cost deployment with all external endpoints configurable via environment variables.

## Milestones & Acceptance Criteria

Implement in order. Validate each milestone before starting the next.

1. **Scaffold** — Vite + React + TS + Tailwind app; Supabase project with migrations, RLS, and anonymous auth; PeerJS and Yjs wired; keep-alive cron; environment-variable config.
   - *Accept:* the app loads, a device receives an anonymous identity, and a Yjs document exists.
2. **M1 — Shared text synchronization (two real devices)** — connect via peer id, Yjs doc synced over the DataChannel, copy-to-clipboard action, editing awareness.
   - *Accept:* two real devices converge live; simultaneous edits merge without silent loss; reconnection restores state.
3. **M2 — Secure device pairing** — QR code with single-use, short-lived token; approval on the existing trusted device via Supabase Realtime; multiple devices; revoke.
   - *Accept:* expired/reused tokens fail; unapproved devices cannot join; revoking a device drops its access.
4. **M3 — QuickDrop file transfer** — multi-file selection, chunked transfer with backpressure, progress and status, cancel and retry, SHA-256 integrity verification.
   - *Accept:* multi-file transfer verified end-to-end; no bytes stored on any server.
5. **M4 — Hardening** — loading/empty/offline/error states; TURN configuration; safe transfer limits; mobile background handling; responsive and accessible pass; tests for synchronization, pairing, transfer failure, and concurrent editing.

## Documented Limitations

- No offline delivery in the MVP — synchronization requires at least one peer to be online.
- Pairing approval requires the existing trusted device to be online.
- Mobile browsers (notably iOS Safari) suspend connections when backgrounded; transfers pause and resume on foreground.
- A web page cannot automatically monitor the native clipboard in all browsers; copying is user-triggered only.
- TURN relay usage scales with bandwidth when a direct connection is impossible.
