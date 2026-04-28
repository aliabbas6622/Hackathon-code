# LIGMA — Production Readiness TODO
> Complete every item before demo. Ordered by rubric impact, not difficulty.

---

## CRITICAL — Points directly at risk

### 1. Fix "No events yet" in LOG sidebar
**Risk: 8 pts**
The event log shows empty despite logEvent() being called in sessionRoom.ts.
- [ ] Check `GET /api/events/:sessionId` REST endpoint exists and returns rows
- [ ] Verify `logEvent()` is not silently swallowing errors (it uses `.catch(() => {})`)
- [ ] Add `console.error` inside the catch in logEvent.ts temporarily to confirm DB writes
- [ ] Test: draw a shape → open LOG tab → event must appear within 6 seconds

### 2. Verify RBAC bypass is blocked server-side
**Risk: 7 pts — judges WILL test this**
- [ ] Lock a node as Lead user
- [ ] Open a raw WebSocket connection (use `wscat` or browser DevTools)
- [ ] Send: `{"type":"op","op":{"type":"update_node","nodeId":"<locked-id>","payload":{"text":"hacked"},"id":"test-1","baseRevision":0,"timestamp":0}}`
- [ ] Server must respond with `{"type":"denial",...}` not apply the change
- [ ] Denial toast must appear if sent from a connected Viewer tab

### 3. Conflict resolution explanation
**Risk: 10 pts**
The OT panel says "OT + LWW" — LWW means Last Write Wins which the rubric explicitly rejects.
- [ ] Either: rename it to accurately reflect what ot.ts actually does (field-level merge + transform)
- [ ] Or: fix ot.ts if it actually does fall back to LWW anywhere
- [ ] README must explain the transform strategy clearly — this is what judges read

### 4. Task Board — verify auto-population without click
**Risk: 10 pts**
Rubric says "within 3 seconds, Task Board shows new task automatically — no manual click"
- [ ] Type "todo: fix login bug" in a sticky note
- [ ] Task Board must update automatically (tasks_changed WebSocket event triggers refresh)
- [ ] Verify OTClient in client handles `tasks_changed` message and calls api.tasks.list()
- [ ] Test with 3-second stopwatch in front of a judge

### 5. Task click scrolls to canvas node
**Risk: 8 pts**
- [ ] Click any task in Task Board
- [ ] Canvas must scroll/pan to that node and highlight it
- [ ] Verify `handleNodeFocus` in App.tsx actually pans the canvas — not just sets state
- [ ] Test: create task, scroll canvas far away, click task, confirm it navigates back

---

## HIGH — Architecture and code quality points

### 6. README (5 pts — free points, do not skip)
- [ ] Create `/README.md` with the following sections:

```
# LIGMA

## Architecture
[ASCII diagram of: Browser → WebSocket → SessionRoom → PostgreSQL + Express REST]

## Technical Decisions

### Why custom OT over Yjs/CRDT
Explain: server-authority model, transform table in ot.ts, field-level merge strategy

### Why append-only event log
Explain: state reconstruction, audit trail, powers Time-Travel Replay

### RBAC enforcement strategy  
Explain: checkRbac() runs server-side in handleMessage BEFORE op is applied.
Client-side is UI affordance only. Server rejects via denial message.
Raw WebSocket bypass is blocked.

### Two-phase AI classification
Explain: keyword heuristic for instant feedback, Gemini 2.0 Flash for confirmed intent.
Prevents 3-second timeout anxiety on the rubric.

### Time-Travel Replay design
Explain: discrete steps (not continuous scrub), reconstructs state by replaying
events 0..N from PostgreSQL. Intentional — continuous scrub is expensive and
unnecessary for brainstorm sessions.

## How to run locally
[step by step]

## Render deployment
[live URL]
```

### 7. Deployment on Render
**Required — without this you cannot be judged**
- [ ] Server deployed on Render as a Web Service
- [ ] Client deployed on Render as a Static Site
- [ ] PostgreSQL provisioned on Render (or Neon.tech)
- [ ] All env vars set: DATABASE_URL, GEMINI_API_KEY, PORT
- [ ] Both services live and accessible via public URL
- [ ] Test the live URL — not just localhost

---

## UI/UX — 15 pts total, currently losing ~8

### 8. Sidebar collapsible
- [ ] Add a collapse toggle button on the sidebar edge
- [ ] Collapsed state: sidebar shrinks to icon-only strip (~48px wide)
- [ ] Canvas expands to fill the space when sidebar is collapsed
- [ ] State persists across tab switches (use useState, not localStorage)

### 9. Responsive layout
- [ ] Canvas + sidebar must not break at 1280px wide (standard judge laptop)
- [ ] No horizontal scrollbar on the main layout
- [ ] Sidebar minimum width: 280px, maximum: 360px
- [ ] Header must not wrap or overflow at any standard width
- [ ] Test at: 1280x800, 1440x900, 1920x1080

### 10. Icon quality
- [ ] Replace all emoji icons (📄🔥📋👥) with proper SVG icons
- [ ] Use lucide-react: `npm install lucide-react`
- [ ] Replacements:
  - 📄 → `<FileText />` (AI Summary)
  - 🔥 → `<Flame />` (Heatmap)
  - 📋 → `<ClipboardList />` (Log tab)  
  - 👥 → `<Users />` (Users tab)
  - 🧠 → `<Brain />` (Tasks tab)
  - ⛔ → `<ShieldX />` (Denial toast)
  - 👑✏️👁 → `<Crown /> <Pencil /> <Eye />` (Role selector)

### 11. Visual consistency
- [ ] Consistent border radius across all cards/buttons (pick one: 8px or 10px)
- [ ] Consistent font sizes: headers 14px bold, body 13px, meta 11px
- [ ] Button hover states on all interactive elements
- [ ] No unstyled default browser elements visible anywhere
- [ ] Denial toast: proper animation (slide in from bottom, auto-dismiss)

### 12. Canvas usability
- [ ] User can add sticky note without explanation (toolbar label or tooltip)
- [ ] Tooltips on all toolbar buttons (title attribute minimum)
- [ ] Node lock indicator visible on locked nodes (small lock icon overlay)
- [ ] Selected node has visible selection ring

---

## DEMO PREPARATION — Stage 1 + Live Demo

### 13. Stage 1 talking points (7 uniqueness pts)
Prepare answers for these exact questions judges will ask:

- "Why did you build a custom OT engine instead of using Yjs?"
  → Answer: Server-authority model gives us the control point for per-node RBAC.
  Yjs is peer-to-peer by design — injecting node-level ACL into the merge
  pipeline requires owning the transform layer.

- "Walk me through what happens when two users edit the same node simultaneously"
  → Answer: Both clients send ops with their baseRevision. Server receives op A,
  commits it at revision N. Op B arrives with stale baseRevision. transform()
  in ot.ts detects the conflict, adjusts B against A's committed changes,
  applies field-level merge. Both clients converge to identical state.

- "How does your RBAC survive a raw WebSocket bypass?"
  → Answer: checkRbac() runs in handleOp() on the server before the op is
  applied to the node map. The client role claim in the 'hello' message is
  trusted for UX only. The node's lockedToRole in server memory is the
  authority. No client can forge a role to bypass it.

- "Why discrete steps in Time-Travel Replay instead of a smooth scrub?"
  → Answer: Continuous scrub requires reconstructing state on every animation
  frame — O(N) event replay per frame. Discrete steps replay once per user
  action. For brainstorm sessions (hundreds of ops, not millions) this is
  the right tradeoff. Smooth scrub would be premature optimization.

### 14. Live demo script (practice this)
```
1. Open two browser tabs
2. Tab A: Join as "Alice" / Lead
3. Tab B: Join as "Bob" / Viewer  
4. Tab A: Draw a shape → show it appears in Tab B (10 pts)
5. Tab A: Type "TODO: fix the auth bug" in a sticky note
   → Show Task Board auto-populates within 3 seconds (10 pts)
6. Tab A: Lock a node
7. Tab B (Viewer): Try to edit locked node → show denial toast (7 pts)
8. Open wscat, send raw WebSocket op to locked node → show server denial (7 pts)
9. Open LOG tab → show event history (8 pts)
10. Open Replay bar → scrub through session history (8 bonus pts)
11. Click 📄 → show AI Summary export (bonus)
```

### 15. Pre-demo checklist (run this 30 min before judging)
- [ ] Server running on Render, not localhost
- [ ] Database has been seeded with a test session
- [ ] Two browser tabs open and connected (green Live indicator)
- [ ] At least 10 events in the log from a test run
- [ ] wscat installed: `npm install -g wscat`
- [ ] Know the exact locked node ID for the RBAC bypass demo
- [ ] README pushed to repo

---

## Priority Order

```
1 → 2 → 3 → 4 → 5   (critical — do these first, in order)
6 → 7                 (high — README and deployment)
8 → 9 → 10 → 11 → 12 (UI — do these after everything works)
13 → 14 → 15          (demo prep — do these last)
```

**Do not touch UI until items 1-5 are verified working.**
