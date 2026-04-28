# LIGMA — Let's Integrate Groups, Manage Anything

A real-time collaborative infinite canvas that automatically extracts structured tasks from brainstorm content.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (React + Vite)                   │
│                                                             │
│  ┌──────────┐   OT ops (WS)   ┌──────────────────────────┐ │
│  │  Canvas   │ ◄────────────► │     OTClient (ot-client)  │ │
│  │ (infinite │   awareness    │  - Optimistic apply       │ │
│  │  pan/zoom)│                │  - Pending queue          │ │
│  └──────────┘                 │  - Transform on broadcast │ │
│  ┌──────────┐                 └───────────┬──────────────┘ │
│  │ TaskBoard│                             │ WebSocket       │
│  │(AI tasks)│                             │ /ws?session=… │ │
│  └──────────┘                             │                 │
└─────────────────────────────────────────── │ ───────────────┘
                                             │
                    ┌────────────────────────▼────────────┐
                    │       Node.js API Server (Express)   │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │     SessionRoom (per-session)  │   │
                    │  │  - Canonical node Map          │   │
                    │  │  - Revision counter            │   │
                    │  │  - OT transform pipeline       │   │
                    │  │  - RBAC enforcement            │   │
                    │  │  - Yjs Awareness (cursors)     │   │
                    │  └──────────────────────────────┘   │
                    │                                      │
                    │  ┌──────────┐  ┌─────────────────┐  │
                    │  │  ot.ts   │  │  classify.ts     │  │
                    │  │(transform│  │(keyword + Gemini) │  │
                    │  │  rules)  │  │  two-phase AI    │  │
                    │  └──────────┘  └─────────────────┘  │
                    └────────────────────┬─────────────────┘
                                         │ pg Pool
                    ┌────────────────────▼─────────────────┐
                    │           PostgreSQL                   │
                    │  events · sessions · nodes            │
                    │  users  · tasks                       │
                    └──────────────────────────────────────┘
```

---

## Challenge Solutions

### Challenge 01 — Conflict Resolution (OT)

**Strategy: Operational Transformation with Last-Write-Wins field merge**

Every canvas mutation is modelled as a typed `Op`:
```
{ id, type, nodeId, userId, baseRevision, payload, timestamp }
```

The server maintains a monotonically-increasing **revision counter**. When a client submits an op:

1. The op carries `baseRevision` — the revision it was authored against.
2. The server collects all ops committed since `baseRevision` (concurrent ops).
3. Each concurrent op is used to **transform** the incoming op via `transform()` in `ot.ts`.
4. The transformed op is applied to the canonical node map and assigned the next revision.

**Transform table (`ot.ts`):**

| Incoming \ Committed | update | delete | lock |
|---|---|---|---|
| **update** | field-level merge (position: LWW by timestamp; text: keep longer) | drop | drop |
| **delete** | — | drop (idempotent) | — |
| **lock** | — | drop | LWW by timestamp |

**Optimistic concurrency on the client (`ot-client.ts`):**
- User action → apply locally immediately → push to `pendingOps` queue → send to server.
- On `op_ack`: remove from pending, confirm revision.
- On `op_broadcast` (peer op): transform against pending ops before applying, so local optimistic state stays consistent.
- On `denial`: rollback by replaying only confirmed ops, then re-applying remaining pending.

This guarantees all clients converge to the same state even when multiple users edit simultaneously — the same mechanism Google Docs uses.

---

### Challenge 02 — Node-Level RBAC

Permissions are enforced in **two places**:

**Server-side (cannot be bypassed):**
- `sessionRoom.ts → checkRbac()` runs before the OT transform.
- If the user's role doesn't permit the operation, the server sends `{ type: 'denial' }`.
- The client's optimistic state is rolled back immediately via a fresh snapshot push.

**Client-side (UI affordances):**
- Viewer: no tools visible, nodes render as read-only.
- Contributor: can create/edit unlocked nodes only.
- Lead: full access + can lock/unlock any node.

Role demotion takes effect without reload — the server pushes `{ type: 'role_ack', role }` over the WebSocket.

---

### Challenge 03 — Intent-Aware Task Extraction

Two-phase classification pipeline triggered whenever a node's text changes:

**Phase 1 — Keyword classifier (< 5ms, synchronous):**
Regex patterns match common signals:
- `todo / task / fix / deadline` → `action_item`
- `decided / approved / we will use` → `decision`
- Trailing `?` or question words → `open_question`
- Fallback → `reference`

Result broadcast immediately so the Task Board updates within ~100ms.

**Phase 2 — Gemini 2.0 Flash (async, if `GEMINI_API_KEY` is set):**
Sends a zero-temperature prompt asking for a single-word classification. Overwrites the keyword result if the AI returns a valid intent type. Marks `confirmed_by_ai = true` on the task row.

Tasks are upserted (not duplicated) per `node_id` — edits to the same node update the existing task in place.

---

### Challenge 04 — Append-Only Event Log

Every canvas mutation calls `logEvent()` which inserts into the `events` table:

```sql
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  seq_num BIGINT GENERATED ALWAYS AS IDENTITY,  -- never reused
  event_type TEXT NOT NULL,
  node_id UUID,
  user_id UUID,
  payload JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`DELETE` operations insert a `delete_node` event — no history is ever removed. The `nodes` table is a mutable projection; the events table is the source of truth from which any historical state can be reconstructed (used by the time-travel replay feature).

---

### Challenge 05 — Real-Time WebSocket Management

- One `WebSocketServer` (from the `ws` library) shares the same `http.Server` as Express.
- The server **broadcasts delta ops only** — never full state dumps — keeping bandwidth proportional to change rate rather than canvas size.
- On reconnect, the server sends `{ type: 'init', revision, nodes }` so the client gets the current snapshot. The client retransmits any unacknowledged pending ops with their original `id` (idempotency guaranteed by the `seenOpIds` set on the server).
- Awareness (cursor presence) uses Yjs `y-protocols` awareness protocol — lightweight presence updates that are separate from the OT op stream.
- Heartbeat: client sends `ping` every 20 seconds; server replies `pong`. Connection drops trigger exponential back-off reconnect (500ms → max 5s).

---

## Bonus Feature — Presence Heatmap

The heatmap overlay (`HeatmapOverlay.tsx`) renders radial gradients over the canvas at positions of heavily-edited nodes. Edit count is derived from the append-only event log — no extra storage required. Toggle via the 🔥 button in the header.

---

## Bonus Feature — AI Summary Export

The 📄 button in the header calls `GET /api/summary/:sessionId` which:
1. Queries all classified tasks from the database, grouped by intent type.
2. If `GEMINI_API_KEY` is set, sends all items to **Gemini 2.0 Flash** with a structured prompt asking for a 3–5 sentence executive narrative.
3. Returns a JSON payload with `{ sections, aiNarrative, source }`.
4. The client renders it as a formatted brief and offers a one-click **⬇ Download .md** that produces a clean Markdown file with the executive summary, decision list, action items, open questions, and references.

Falls back gracefully to the structured-only view if no API key is configured.

---

## Bonus Feature — Time-Travel Replay

The replay bar at the bottom of the screen allows scrubbing through the full session history. Selecting a sequence number replays all events up to that point, reconstructing the canvas state client-side. Canvas enters read-only mode during replay.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite, TypeScript |
| Real-time | WebSocket (ws), OT engine (custom), Yjs Awareness |
| Backend | Node.js, Express 5, TypeScript, esbuild |
| Database | PostgreSQL (pg pool, raw SQL, append-only events) |
| AI | Gemini 1.5 Flash via REST (with keyword fallback) |
| Monorepo | pnpm workspaces |

---

## Running Locally

```bash
pnpm install
# Start API server (port 8080)
pnpm --filter @workspace/api-server run dev
# Start frontend (port 21845)
pnpm --filter @workspace/ligma run dev
```

Open multiple browser tabs to test real-time collaboration.
"# Hackathon-code" 
