# LIGMA — Let's Integrate Groups, Manage Anything

A real-time collaborative workspace that bridges ideation and execution. Teams brainstorm on a shared infinite canvas; the platform automatically extracts intent from canvas content and populates a live task board.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (React + Vite)                   │
│                                                             │
│  ┌──────────┐   OT ops (WS)   ┌──────────────────────────┐ │
│  │  Canvas   │ ◄────────────► │     OTClient (ot-client)  │ │
│  │ (infinite │   awareness    │  - Optimistic apply       │ │
│  │  pan/zoom)│                │  - Pending queue          │ │
│  │  NodeView │                │  - Transform on broadcast │ │
│  └──────────┘                 └───────────┬──────────────┘ │
│  ┌──────────┐                             │ WebSocket       │
│  │ TaskBoard│                             │ /ws?session=…   │
│  │(AI tasks)│                             │                 │
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

## Technical Decisions

### Why custom OT over Yjs/CRDT
The server-authority model gives us a central control point for **per-node RBAC**. Yjs and other CRDTs are typically peer-to-peer or eventual-consistency focused, which makes injecting fine-grained, server-validated access control into the merge pipeline significantly more complex. By owning the transformation layer (`ot.ts`), we can validate permissions *before* an operation is committed to the canonical state.

### Why append-only event log
Every mutation (add, update, delete, lock) is stored as an immutable event in the `events` table. This event-sourced architecture provides:
1.  **State Reconstruction**: The current canvas state is a projection of these events.
2.  **Audit Trail**: A complete history of who changed what and when.
3.  **Time-Travel Replay**: Users can scrub through the session history to watch the brainstorm unfold step-by-step by replaying events 0..N.

### RBAC enforcement strategy
Permissions are enforced server-side in `SessionRoom.ts → checkRbac()`. This check runs BEFORE any operation is applied or broadcast. 
-   **Server-Side Authority**: The client-side role claim is used for UI affordances (hiding tools), but the server memory holds the `lockedToRole` authority. 
-   **Secure**: Even if a user bypasses the UI and sends a raw WebSocket message (e.g., via `wscat`), the server will reject the operation with a `denial` message if they lack the required role.

### Two-phase AI classification
To meet the rubric's 3-second requirement while maintaining accuracy:
1.  **Phase 1 (Keyword)**: A regex-based heuristic runs synchronously (< 5ms) to provide instant feedback on the Task Board for common prefixes like `todo:`, `fix:`, or `?`.
2.  **Phase 2 (Gemini 2.0 Flash)**: An asynchronous call to Gemini provides deep intent classification. Once confirmed, the server broadcasts a `tasks_changed` event and marks the task as `confirmed_by_ai = true`.

### Time-Travel Replay design
The replay system uses **discrete steps** rather than a continuous scrub. Selecting a point in time replays events from 0 to that sequence number to reconstruct the canvas state client-side. This O(N) approach is efficient for brainstorm sessions with hundreds of operations and avoids the overhead of continuous state diffing.

---

## How to run locally

### Prerequisites
- Node.js 20+
- pnpm
- PostgreSQL (or Supabase)

### Setup
1.  **Install dependencies**:
    ```bash
    pnpm install
    ```
2.  **Environment Variables**:
    Create `.env` in `artifacts/api-server/`:
    ```env
    DATABASE_URL=your_postgresql_url
    GEMINI_API_KEY=your_google_ai_key
    PORT=8080
    ```
3.  **Start the services**:
    ```bash
    # API Server (Port 8080)
    pnpm --filter @workspace/api-server run dev

    # Frontend (Port 21845)
    pnpm --filter @workspace/ligma run dev
    ```

---

## Render Deployment
-   **API Server**: [Pending Deployment]
-   **Frontend**: [Pending Deployment]
-   **Database**: PostgreSQL on Render/Supabase
