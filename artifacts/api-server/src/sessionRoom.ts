/**
 * SessionRoom — per-session collaboration engine.
 *
 * Implements a hybrid OT + Yjs awareness architecture:
 *   • Canvas state lives in an in-memory node map, mutated via the OT engine.
 *   • Yjs Awareness is used solely for cursor/presence propagation.
 *   • Each validated canvas op is committed with a monotonically-increasing
 *     revision number, persisted to PostgreSQL, and broadcast to peers.
 *   • Clients apply ops optimistically; the server transforms concurrently
 *     submitted ops to guarantee convergence (see ot.ts).
 */

import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { WebSocket } from 'ws';
import { canEditNode, canCreateNode, canDeleteNode, canChangeLock, type Role } from './rbac.js';
import { logEvent } from './logEvent.js';
import { classifyByKeyword, classifyByAI } from './classify.js';
import { transform, applyOp, type Op, type CommittedOp, type NodeFields } from './ot.js';
import { pool } from '@workspace/db';

export interface ClientConn {
  ws: WebSocket;
  userId: string;
  userName: string;
  role: Role;
  color: string;
  awarenessClientId: number;
}

type InboundMsg =
  | { type: 'hello'; userId: string; userName: string; role: Role; color: string }
  | { type: 'role_change'; role: Role }
  | { type: 'op'; op: Op }
  | { type: 'awareness_update'; update: number[] }
  | { type: 'ping' };

// Each session room is a singleton per sessionId.
export class SessionRoom {
  readonly sessionId: string;

  // Canonical node state — single source of truth.
  private nodes = new Map<string, NodeFields & { id: string }>();

  // Committed op log (in-memory cache of DB events).
  private opLog: CommittedOp[] = [];

  // Monotonically-increasing revision counter.
  private revision = 0;

  // Seen op IDs — for client-side deduplication (idempotency).
  private seenOpIds = new Set<string>();

  // Connected peers.
  private conns = new Set<ClientConn>();

  // Yjs doc used only for awareness (cursor presence).
  private doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.awareness.setLocalState(null);
  }

  // ------------------------------------------------------------------ connect

  attach(conn: ClientConn) {
    this.conns.add(conn);
    // Send full state snapshot so the client can initialize.
    this.send(conn.ws, {
      type: 'init',
      revision: this.revision,
      nodes: Array.from(this.nodes.values()),
    });
    // Send current awareness state.
    const awarenessUpdate = encodeAwarenessUpdate(
      this.awareness,
      Array.from(this.awareness.getStates().keys()),
    );
    if (awarenessUpdate.length > 2) {
      this.send(conn.ws, { type: 'awareness_update', update: Array.from(awarenessUpdate) });
    }
  }

  detach(conn: ClientConn) {
    this.conns.delete(conn);
    removeAwarenessStates(this.awareness, [conn.awarenessClientId], 'detach');
    this.broadcastAwareness([conn.awarenessClientId], conn);
    // Log disconnect.
    logEvent({
      sessionId: this.sessionId,
      eventType: 'user_disconnected',
      userId: conn.userId,
      payload: { userName: conn.userName, role: conn.role },
    }).catch(() => {});
  }

  // --------------------------------------------------------------- messaging

  async handleMessage(conn: ClientConn, raw: string): Promise<void> {
    let msg: InboundMsg;
    try {
      msg = JSON.parse(raw) as InboundMsg;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello':
        conn.userId = msg.userId;
        conn.userName = msg.userName;
        conn.role = msg.role;
        conn.color = msg.color;
        // Log connect event.
        logEvent({
          sessionId: this.sessionId,
          eventType: 'user_connected',
          userId: conn.userId,
          payload: { userName: conn.userName, role: conn.role },
        }).catch(() => {});
        return;

      case 'role_change':
        conn.role = msg.role;
        this.send(conn.ws, { type: 'role_ack', role: msg.role });
        return;

      case 'awareness_update': {
        const update = new Uint8Array(msg.update);
        applyAwarenessUpdate(this.awareness, update, conn);
        this.broadcastAwareness([], conn);
        return;
      }

      case 'op':
        await this.handleOp(conn, msg.op);
        return;

      case 'ping':
        this.send(conn.ws, { type: 'pong' });
        return;
    }
  }

  // ------------------------------------------------------------------ OT core

  /**
   * Process an incoming canvas operation through the OT pipeline:
   *
   *   1. Idempotency check (op.id already seen → re-ack and return).
   *   2. RBAC check on the *current* canonical state.
   *   3. OT transform against all ops committed since op.baseRevision.
   *   4. Apply the transformed op to the canonical node map.
   *   5. Assign a new revision, persist to DB, broadcast to peers.
   *   6. Trigger async AI intent classification for text-bearing nodes.
   */
  private async handleOp(conn: ClientConn, incoming: Op): Promise<void> {
    // 1. Idempotency — client may retry on reconnect.
    if (this.seenOpIds.has(incoming.id)) {
      this.send(conn.ws, { type: 'op_ack', opId: incoming.id, revision: this.revision });
      return;
    }

    // 2. RBAC check against canonical state.
    const rbacError = this.checkRbac(conn, incoming);
    if (rbacError) {
      this.send(conn.ws, {
        type: 'denial',
        opId: incoming.id,
        reason: rbacError,
        nodeId: incoming.nodeId,
      });
      // Push a snapshot so the client's optimistic state reverts.
      this.attach(conn);
      return;
    }

    // 3. OT transform against concurrent ops.
    const transformed = transform(incoming, this.opLog);
    if (!transformed) {
      // Transform reduced the op to a no-op (e.g. update on a deleted node).
      this.send(conn.ws, { type: 'op_ack', opId: incoming.id, revision: this.revision, dropped: true });
      return;
    }

    // 4. Apply to canonical state.
    const revision = ++this.revision;
    const committed: CommittedOp = { ...transformed, revision };
    applyOp(this.nodes, committed);
    this.opLog.push(committed);
    this.seenOpIds.add(incoming.id);

    // Trim in-memory log to last 2000 ops.
    if (this.opLog.length > 2000) this.opLog.splice(0, this.opLog.length - 2000);

    // 5. Persist + broadcast.
    await logEvent({
      sessionId: this.sessionId,
      eventType: transformed.type,
      nodeId: transformed.nodeId,
      userId: conn.userId,
      payload: { ...transformed.payload, revision, opId: transformed.id },
    }).catch(() => {});

    // Persist node row for lock lookups.
    if (transformed.type === 'add_node' || transformed.type === 'lock_node') {
      const node = this.nodes.get(transformed.nodeId);
      pool.query(
        `INSERT INTO nodes (id, session_id, owner_id, locked_to_role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET locked_to_role = EXCLUDED.locked_to_role`,
        [
          transformed.nodeId,
          this.sessionId,
          conn.userId,
          node?.lockedToRole ?? null,
        ],
      ).catch(() => {});
    }
    if (transformed.type === 'delete_node') {
      pool.query(
        `DELETE FROM nodes WHERE id = $1`,
        [transformed.nodeId],
      ).catch(() => {});
    }

    // Ack the submitting client.
    this.send(conn.ws, {
      type: 'op_ack',
      opId: incoming.id,
      revision,
      transformedOp: committed,
    });

    // Broadcast to all other peers.
    for (const peer of this.conns) {
      if (peer === conn) continue;
      this.send(peer.ws, { type: 'op_broadcast', revision, op: committed });
    }

    // 6. Async AI intent classification for text nodes.
    if (
      (transformed.type === 'add_node' || transformed.type === 'update_node') &&
      transformed.payload.text
    ) {
      this.classifyAndBroadcast(transformed.nodeId, transformed.payload.text, conn.userId).catch(
        () => {},
      );
    }
  }

  // ------------------------------------------------------------------ RBAC

  private checkRbac(conn: ClientConn, op: Op): string | null {
    const existing = this.nodes.get(op.nodeId);

    switch (op.type) {
      case 'add_node':
        if (!canCreateNode(conn.role)) return `${conn.role} cannot create nodes`;
        return null;

      case 'update_node':
        if (!existing) return null; // node doesn't exist yet — will be dropped by OT
        if (!canEditNode(conn.role, existing.lockedToRole as any)) {
          return `${conn.role} cannot edit node locked to ${existing.lockedToRole}`;
        }
        return null;

      case 'delete_node':
        if (!existing) return null;
        if (!canDeleteNode(conn.role, existing.lockedToRole as any)) {
          return `${conn.role} cannot delete node locked to ${existing.lockedToRole}`;
        }
        return null;

      case 'lock_node':
        if (!canChangeLock(conn.role)) return `Only Lead can change node locks (${conn.userName} is ${conn.role})`;
        return null;

      default:
        return null;
    }
  }

  // --------------------------------------------------------------- intent AI

  private async classifyAndBroadcast(
    nodeId: string,
    text: string,
    userId: string,
  ): Promise<void> {
    // Phase-1: instant keyword classification.
    const kw = classifyByKeyword(text);

    // Apply keyword result to canonical state immediately.
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.intent = kw.intent;
    node.intentConfidence = kw.confidence;
    node.intentSource = kw.source;

    // Broadcast the intent update to all peers.
    const kwRev = ++this.revision;
    const kwOp: CommittedOp = {
      id: `intent-kw-${nodeId}-${kwRev}`,
      type: 'update_node',
      nodeId,
      userId,
      baseRevision: kwRev - 1,
      payload: { intent: kw.intent, intentConfidence: kw.confidence, intentSource: kw.source },
      timestamp: Date.now(),
      revision: kwRev,
    };
    this.opLog.push(kwOp);
    for (const peer of this.conns) {
      this.send(peer.ws, { type: 'op_broadcast', revision: kwRev, op: kwOp });
    }

    // Persist task row (upsert).
    await this.upsertTask(nodeId, userId, text, kw.intent, false);

    // Phase-2: Gemini AI classification (async).
    const ai = await classifyByAI(text);
    if (ai.source !== 'ai') return; // no API key — skip

    const aiNode = this.nodes.get(nodeId);
    if (!aiNode) return;
    aiNode.intent = ai.intent;
    aiNode.intentConfidence = ai.confidence;
    aiNode.intentSource = 'ai';

    const aiRev = ++this.revision;
    const aiOp: CommittedOp = {
      id: `intent-ai-${nodeId}-${aiRev}`,
      type: 'update_node',
      nodeId,
      userId,
      baseRevision: aiRev - 1,
      payload: { intent: ai.intent, intentConfidence: ai.confidence, intentSource: 'ai' },
      timestamp: Date.now(),
      revision: aiRev,
    };
    this.opLog.push(aiOp);
    for (const peer of this.conns) {
      this.send(peer.ws, { type: 'op_broadcast', revision: aiRev, op: aiOp });
    }

    await this.upsertTask(nodeId, userId, text, ai.intent, true);
    // Notify clients to refresh task board.
    for (const peer of this.conns) {
      this.send(peer.ws, { type: 'tasks_changed' });
    }
  }

  private async upsertTask(
    nodeId: string,
    userId: string,
    title: string,
    intentType: string,
    confirmedByAi: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO tasks (session_id, node_id, author_id, title, intent_type, confirmed_by_ai, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (node_id) DO UPDATE
         SET title = EXCLUDED.title,
             intent_type = EXCLUDED.intent_type,
             confirmed_by_ai = EXCLUDED.confirmed_by_ai,
             updated_at = NOW()`,
      [this.sessionId, nodeId, userId, title.slice(0, 500), intentType, confirmedByAi],
    ).catch(() => {});
  }

  // -------------------------------------------------------- role push (admin)

  pushRoleChange(userId: string, newRole: Role): void {
    for (const conn of this.conns) {
      if (conn.userId === userId) {
        conn.role = newRole;
        this.send(conn.ws, { type: 'role_ack', role: newRole });
      }
    }
  }

  // ----------------------------------------------------------- awareness relay

  private broadcastAwareness(removed: number[], exclude: ClientConn): void {
    const keys = Array.from(this.awareness.getStates().keys()).filter(
      (k) => !removed.includes(k),
    );
    if (keys.length === 0 && removed.length === 0) return;
    const update = encodeAwarenessUpdate(this.awareness, [...keys, ...removed]);
    for (const peer of this.conns) {
      if (peer === exclude) continue;
      this.send(peer.ws, { type: 'awareness_update', update: Array.from(update) });
    }
  }

  // ------------------------------------------------------------------ helpers

  getNodes(): Array<NodeFields & { id: string }> {
    return Array.from(this.nodes.values());
  }

  getRevision(): number {
    return this.revision;
  }

  getOpLog(): CommittedOp[] {
    return this.opLog;
  }

  connCount(): number {
    return this.conns.size;
  }

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }
}

// ------------------------------------------------------------------ registry

const rooms = new Map<string, SessionRoom>();

export function getRoom(sessionId: string): SessionRoom {
  let room = rooms.get(sessionId);
  if (!room) {
    room = new SessionRoom(sessionId);
    rooms.set(sessionId, room);
  }
  return room;
}
