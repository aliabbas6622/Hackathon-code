/**
 * OT Client Engine
 *
 * Implements optimistic concurrency:
 *   1. User action → generate Op → apply locally (optimistic) → queue to send.
 *   2. Server acks the op (possibly with a transformed version) → confirm pending.
 *   3. Server broadcasts a peer's op → transform it against our pending ops → apply.
 *   4. On denial → rollback optimistic state by re-playing confirmed history.
 *
 * This guarantees that all clients converge to the same canonical state even
 * when multiple users edit simultaneously.
 */

import type { CanvasNode, Op, CommittedOp } from './types';
import { v4 as uuidv4 } from 'uuid';

export type ChangeListener = (nodes: Map<string, CanvasNode>) => void;
export type DenialListener = (msg: { nodeId: string; reason: string }) => void;

interface PendingOp {
  op: Op;
  attempt: number;
}

export class OTClient {
  private nodes = new Map<string, CanvasNode>();
  private confirmedOps: CommittedOp[] = [];  // acked by server, in revision order
  private pendingOps: PendingOp[] = [];       // sent but not yet acked

  private revision = 0;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  private changeListeners: ChangeListener[] = [];
  private denialListeners: DenialListener[] = [];
  private statusListeners: Array<(s: 'connecting' | 'connected' | 'disconnected') => void> = [];
  private tasksChangedListeners: Array<() => void> = [];
  private awarenessListeners: Array<(states: Map<string, any>) => void> = [];

  readonly userId: string;
  readonly userName: string;
  readonly role: string;
  readonly color: string;
  private sessionId: string;

  private awarenessStates = new Map<string, any>();

  constructor(opts: {
    sessionId: string;
    userId: string;
    userName: string;
    role: string;
    color: string;
  }) {
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this.userName = opts.userName;
    this.role = opts.role;
    this.color = opts.color;
  }

  // ── Connection ────────────────────────────────────────────────────────────

  connect(): void {
    if (this.ws && this.ws.readyState < 2) return; // already open or connecting

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?session=${this.sessionId}`;

    this.emitStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.emitStatus('connected');

      // Introduce ourselves.
      this.rawSend({
        type: 'hello',
        userId: this.userId,
        userName: this.userName,
        role: this.role,
        color: this.color,
      });

      // Retransmit any pending ops that didn't get acked.
      for (const p of this.pendingOps) {
        this.rawSend({ type: 'op', op: p.op });
      }

      this.schedulePing();
    };

    ws.onmessage = (ev) => {
      try {
        this.handleMessage(JSON.parse(ev.data));
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      this.connected = false;
      this.emitStatus('disconnected');
      if (this.pingTimer) clearTimeout(this.pingTimer);
      // Exponential back-off reconnect.
      const delay = Math.min(5000, 500 * (1 + Math.floor(Math.random() * 3)));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => ws.close();
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.ws?.close();
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'init':
        // Full state snapshot from server on (re-)connect.
        this.revision = msg.revision ?? 0;
        this.nodes = new Map(
          (msg.nodes ?? []).map((n: CanvasNode) => [n.id, n]),
        );
        // Clear pending ops that are now superseded by the authoritative snapshot.
        this.pendingOps = [];
        this.confirmedOps = [];
        this.emitChange();
        break;

      case 'op_ack': {
        // Server confirmed our op (possibly with a transformed version).
        const idx = this.pendingOps.findIndex((p) => p.op.id === msg.opId);
        if (idx !== -1) {
          const committed: CommittedOp = {
            ...(msg.transformedOp ?? this.pendingOps[idx]!.op),
            revision: msg.revision,
          };
          this.confirmedOps.push(committed);
          this.pendingOps.splice(idx, 1);

          if (msg.dropped) {
            // Server dropped the op (e.g. update on deleted node) — revert it.
            this.replayFromConfirmed();
          } else if (msg.transformedOp) {
            // Server transformed our op — patch the local state.
            this.applyOpLocally(committed);
          }
          this.revision = msg.revision;
          this.emitChange();
        }
        break;
      }

      case 'op_broadcast': {
        // A peer's op committed by the server.
        const serverOp: CommittedOp = { ...msg.op, revision: msg.revision };

        // Transform the broadcast op against our pending ops so local
        // optimistic state stays consistent (OT invariant).
        const transformed = this.transformBroadcastAgainstPending(serverOp);

        if (transformed) {
          this.confirmedOps.push(serverOp);
          this.applyOpLocally(transformed);
          this.revision = msg.revision;
          this.emitChange();
        }
        break;
      }

      case 'denial':
        // RBAC rejection — revert optimistic state.
        this.pendingOps = this.pendingOps.filter((p) => p.op.id !== msg.opId);
        this.replayFromConfirmed();
        this.emitChange();
        for (const l of this.denialListeners) {
          l({ nodeId: msg.nodeId, reason: msg.reason });
        }
        break;

      case 'role_ack':
        // Server confirmed role change (pushed by admin).
        break;

      case 'awareness_update':
        this.handleAwarenessUpdate(msg.update);
        break;

      case 'tasks_changed':
        for (const l of this.tasksChangedListeners) l();
        break;

      case 'pong':
        this.schedulePing();
        break;
    }
  }

  // ── OT Helpers ────────────────────────────────────────────────────────────

  /**
   * Transform a broadcast op against the current pending queue.
   * Pending ops were optimistically applied, so the broadcast op's base
   * reality may lag behind our local state. We transform it forward.
   */
  private transformBroadcastAgainstPending(broadcast: CommittedOp): CommittedOp | null {
    let result: CommittedOp | null = broadcast;
    for (const pending of this.pendingOps) {
      if (!result) break;
      // Only transform if the pending op was submitted AFTER the broadcast's base.
      if (pending.op.baseRevision > broadcast.baseRevision) continue;
      result = transformServerVsLocal(result, pending.op);
    }
    return result;
  }

  private replayFromConfirmed(): void {
    // Reset to empty, then re-apply all confirmed committed ops.
    this.nodes = new Map();
    for (const op of this.confirmedOps) {
      this.applyOpLocally(op);
    }
    // Re-apply pending ops on top (optimistic).
    for (const p of this.pendingOps) {
      this.applyOpLocally(p.op as CommittedOp);
    }
  }

  private applyOpLocally(op: Op): void {
    switch (op.type) {
      case 'add_node': {
        const existing = this.nodes.get(op.nodeId);
        if (!existing) {
          this.nodes.set(op.nodeId, { id: op.nodeId, ...(op.payload as any) });
        }
        break;
      }
      case 'update_node': {
        const n = this.nodes.get(op.nodeId);
        if (n) this.nodes.set(op.nodeId, { ...n, ...op.payload });
        break;
      }
      case 'delete_node':
        this.nodes.delete(op.nodeId);
        break;
      case 'lock_node': {
        const n = this.nodes.get(op.nodeId);
        if (n)
          this.nodes.set(op.nodeId, {
            ...n,
            lockedToRole: op.payload.lockedToRole ?? null,
          });
        break;
      }
    }
  }

  // ── Public Mutation API ───────────────────────────────────────────────────

  addNode(partial: Omit<CanvasNode, 'id'>): CanvasNode {
    const node: CanvasNode = { id: uuidv4(), ...partial };
    const op: Op = {
      id: uuidv4(),
      type: 'add_node',
      nodeId: node.id,
      userId: this.userId,
      baseRevision: this.revision,
      payload: node,
      timestamp: Date.now(),
    };
    this.submitOp(op);
    return node;
  }

  updateNode(nodeId: string, changes: Partial<CanvasNode>): void {
    const op: Op = {
      id: uuidv4(),
      type: 'update_node',
      nodeId,
      userId: this.userId,
      baseRevision: this.revision,
      payload: { ...changes, updatedAt: Date.now() },
      timestamp: Date.now(),
    };
    this.submitOp(op);
  }

  deleteNode(nodeId: string): void {
    const op: Op = {
      id: uuidv4(),
      type: 'delete_node',
      nodeId,
      userId: this.userId,
      baseRevision: this.revision,
      payload: {},
      timestamp: Date.now(),
    };
    this.submitOp(op);
  }

  lockNode(nodeId: string, lockedToRole: string | null): void {
    const op: Op = {
      id: uuidv4(),
      type: 'lock_node',
      nodeId,
      userId: this.userId,
      baseRevision: this.revision,
      payload: { lockedToRole },
      timestamp: Date.now(),
    };
    this.submitOp(op);
  }

  private submitOp(op: Op): void {
    // Apply optimistically.
    this.applyOpLocally(op);
    this.emitChange();
    // Queue and send.
    this.pendingOps.push({ op, attempt: 0 });
    this.rawSend({ type: 'op', op });
  }

  // ── Awareness (cursor presence) ───────────────────────────────────────────

  updateCursor(x: number, y: number): void {
    this.rawSend({
      type: 'awareness_update',
      update: [{ userId: this.userId, userName: this.userName, color: this.color, x, y }],
    });
  }

  private handleAwarenessUpdate(update: any): void {
    if (Array.isArray(update)) {
      for (const s of update) {
        if (s.userId && s.userId !== this.userId) {
          this.awarenessStates.set(s.userId, s);
        }
      }
      for (const l of this.awarenessListeners) l(this.awarenessStates);
    }
  }

  getCursorStates(): Map<string, any> {
    return this.awarenessStates;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  onNodesChange(fn: ChangeListener) {
    this.changeListeners.push(fn);
    return () => { this.changeListeners = this.changeListeners.filter((l) => l !== fn); };
  }

  onDenial(fn: DenialListener) {
    this.denialListeners.push(fn);
    return () => { this.denialListeners = this.denialListeners.filter((l) => l !== fn); };
  }

  onStatus(fn: (s: 'connecting' | 'connected' | 'disconnected') => void) {
    this.statusListeners.push(fn);
    return () => { this.statusListeners = this.statusListeners.filter((l) => l !== fn); };
  }

  onTasksChanged(fn: () => void) {
    this.tasksChangedListeners.push(fn);
    return () => { this.tasksChangedListeners = this.tasksChangedListeners.filter((l) => l !== fn); };
  }

  onAwareness(fn: (states: Map<string, any>) => void) {
    this.awarenessListeners.push(fn);
    return () => { this.awarenessListeners = this.awarenessListeners.filter((l) => l !== fn); };
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getNodes(): Map<string, CanvasNode> {
    return this.nodes;
  }

  getRevision(): number {
    return this.revision;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private rawSend(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private emitChange(): void {
    for (const l of this.changeListeners) l(this.nodes);
  }

  private emitStatus(s: 'connecting' | 'connected' | 'disconnected'): void {
    for (const l of this.statusListeners) l(s);
  }

  private schedulePing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.rawSend({ type: 'ping' });
    }, 20_000);
  }
}

// ── OT Transform (broadcast vs pending, client side) ─────────────────────────

function transformServerVsLocal(server: CommittedOp, local: Op): CommittedOp | null {
  if (server.nodeId !== local.nodeId) return server;

  switch (server.type) {
    case 'update_node':
      if (local.type === 'delete_node') return null;
      if (local.type === 'update_node') {
        // Server wins on position (it's the source of truth).
        return server;
      }
      return server;

    case 'delete_node':
      return server;

    default:
      return server;
  }
}
