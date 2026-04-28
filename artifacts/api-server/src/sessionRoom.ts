/**
 * SessionRoom — per-session collaboration engine.
 *
 * OT pipeline:
 *   • Canvas state = in-memory node map, mutated via the OT engine (ot.ts).
 *   • Every validated op is committed with a monotonically-increasing revision
 *     number, persisted to PostgreSQL, and broadcast as a delta to peers.
 *   • Cursor presence = lightweight JSON relay (no Yjs dependency here).
 *   • Clients apply ops optimistically; the server transforms concurrent ops to
 *     guarantee convergence (see ot.ts for the full transform table).
 */

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
}

type InboundMsg =
  | { type: 'hello'; userId: string; userName: string; role: Role; color: string }
  | { type: 'role_change'; role: Role }
  | { type: 'op'; op: Op }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'ping' };

export class SessionRoom {
  readonly sessionId: string;

  private nodes = new Map<string, NodeFields & { id: string }>();
  private opLog: CommittedOp[] = [];
  private revision = 0;
  private seenOpIds = new Set<string>();
  private conns = new Set<ClientConn>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  // ── Connect / disconnect ──────────────────────────────────────────────────

  attach(conn: ClientConn): void {
    this.conns.add(conn);
    this.send(conn.ws, {
      type: 'init',
      revision: this.revision,
      nodes: Array.from(this.nodes.values()),
    });
  }

  detach(conn: ClientConn): void {
    this.conns.delete(conn);
    // Notify peers this cursor is gone
    this.broadcast({ type: 'cursor_leave', userId: conn.userId }, conn);
    logEvent({
      sessionId: this.sessionId,
      eventType: 'user_disconnected',
      userId: conn.userId,
      payload: { userName: conn.userName, role: conn.role },
    }).catch((err) => { console.error('[SessionRoom] Failed to log user_disconnected:', err); });
  }

  // ── Message dispatcher ────────────────────────────────────────────────────

  async handleMessage(conn: ClientConn, raw: string): Promise<void> {
    let msg: InboundMsg;
    try { msg = JSON.parse(raw) as InboundMsg; } catch { return; }

    switch (msg.type) {
      case 'hello':
        conn.userId   = msg.userId;
        conn.userName = msg.userName;
        conn.role     = msg.role;
        conn.color    = msg.color;
        logEvent({
          sessionId: this.sessionId,
          eventType: 'user_connected',
          userId: conn.userId,
          payload: { userName: conn.userName, role: conn.role },
        }).catch((err) => console.error('logEvent failed:', err));
        // Broadcast this user's presence to existing peers
        this.broadcast({ type: 'peer_joined', userId: conn.userId, userName: conn.userName, color: conn.color, role: conn.role }, conn);
        return;

      case 'role_change':
        conn.role = msg.role;
        this.send(conn.ws, { type: 'role_ack', role: msg.role });
        return;

      case 'cursor':
        this.broadcast({
          type: 'cursor',
          userId: conn.userId,
          userName: conn.userName,
          color: conn.color,
          x: msg.x,
          y: msg.y,
        }, conn);
        return;

      case 'op':
        await this.handleOp(conn, msg.op);
        return;

      case 'ping':
        this.send(conn.ws, { type: 'pong' });
        return;
    }
  }

  // ── OT core ───────────────────────────────────────────────────────────────

  private async handleOp(conn: ClientConn, incoming: Op): Promise<void> {
    // Idempotency
    if (this.seenOpIds.has(incoming.id)) {
      this.send(conn.ws, { type: 'op_ack', opId: incoming.id, revision: this.revision });
      return;
    }

    // RBAC
    const rbacError = this.checkRbac(conn, incoming);
    if (rbacError) {
      this.send(conn.ws, { type: 'denial', opId: incoming.id, reason: rbacError, nodeId: incoming.nodeId });
      // Push fresh snapshot so optimistic state reverts
      this.send(conn.ws, { type: 'init', revision: this.revision, nodes: Array.from(this.nodes.values()) });
      return;
    }

    // OT transform
    const transformed = transform(incoming, this.opLog);
    if (!transformed) {
      this.send(conn.ws, { type: 'op_ack', opId: incoming.id, revision: this.revision, dropped: true });
      return;
    }

    // Apply
    const revision = ++this.revision;
    const committed: CommittedOp = { ...transformed, revision };
    applyOp(this.nodes, committed);
    this.opLog.push(committed);
    this.seenOpIds.add(incoming.id);
    if (this.opLog.length > 2000) this.opLog.splice(0, this.opLog.length - 2000);

    // Persist event
    await logEvent({
      sessionId: this.sessionId,
      eventType: transformed.type,
      nodeId: transformed.nodeId,
      userId: conn.userId,
      payload: { ...transformed.payload, revision, opId: transformed.id },
    }).catch((err) => console.error('logEvent failed:', err));

    // Persist node row
    if (transformed.type === 'add_node' || transformed.type === 'lock_node') {
      const node = this.nodes.get(transformed.nodeId);
      pool.query(
        `INSERT INTO nodes (id, session_id, owner_id, locked_to_role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET locked_to_role = EXCLUDED.locked_to_role`,
        [transformed.nodeId, this.sessionId, conn.userId, node?.lockedToRole ?? null],
      ).catch((err) => { console.error('[SessionRoom] Failed to upsert node:', err); });
    }
    if (transformed.type === 'delete_node') {
      pool.query(`DELETE FROM nodes WHERE id = $1`, [transformed.nodeId]).catch((err) => { console.error('[SessionRoom] Failed to delete node:', err); });
    }

    // Ack submitter
    this.send(conn.ws, { type: 'op_ack', opId: incoming.id, revision, transformedOp: committed });

    // Broadcast delta to peers
    this.broadcast({ type: 'op_broadcast', revision, op: committed }, conn);

    // AI intent classification
    if (
      (transformed.type === 'add_node' || transformed.type === 'update_node') &&
      transformed.payload.text
    ) {
      this.classifyAndBroadcast(transformed.nodeId, transformed.payload.text, conn.userId).catch((err) => { console.error('[SessionRoom] Failed classifyAndBroadcast:', err); });
    }
  }

  // ── RBAC ──────────────────────────────────────────────────────────────────

  private checkRbac(conn: ClientConn, op: Op): string | null {
    const existing = this.nodes.get(op.nodeId);
    switch (op.type) {
      case 'add_node':
        return canCreateNode(conn.role) ? null : `${conn.role} cannot create nodes`;
      case 'update_node':
        if (!existing) return null;
        return canEditNode(conn.role, existing.lockedToRole as any)
          ? null
          : `${conn.role} cannot edit node locked to ${existing.lockedToRole}`;
      case 'delete_node':
        if (!existing) return null;
        return canDeleteNode(conn.role, existing.lockedToRole as any)
          ? null
          : `${conn.role} cannot delete node locked to ${existing.lockedToRole}`;
      case 'lock_node':
        return canChangeLock(conn.role) ? null : `Only Lead can lock nodes (you are ${conn.role})`;
      default:
        return null;
    }
  }

  // ── AI intent classification ──────────────────────────────────────────────

  private async classifyAndBroadcast(nodeId: string, text: string, userId: string): Promise<void> {
    // Phase 1: keyword
    const kw = classifyByKeyword(text);
    const node = this.nodes.get(nodeId);
    if (!node) return;

    Object.assign(node, { intent: kw.intent, intentConfidence: kw.confidence, intentSource: kw.source });

    const kwRev = ++this.revision;
    const kwOp: CommittedOp = {
      id: `intent-kw-${nodeId}-${kwRev}`,
      type: 'update_node', nodeId, userId,
      baseRevision: kwRev - 1,
      payload: { intent: kw.intent, intentConfidence: kw.confidence, intentSource: kw.source },
      timestamp: Date.now(), revision: kwRev,
    };
    this.opLog.push(kwOp);
    for (const peer of this.conns) {
      this.send(peer.ws, { type: 'op_broadcast', revision: kwRev, op: kwOp });
    }
    await this.upsertTask(nodeId, userId, text, kw.intent, false);
    for (const peer of this.conns) {
      this.send(peer.ws, { type: 'tasks_changed' });
    }

    // Phase 2: Gemini
    const ai = await classifyByAI(text);
    if (ai.source !== 'ai') return;

    const aiNode = this.nodes.get(nodeId);
    if (!aiNode) return;
    Object.assign(aiNode, { intent: ai.intent, intentConfidence: ai.confidence, intentSource: 'ai' });

    const aiRev = ++this.revision;
    const aiOp: CommittedOp = {
      id: `intent-ai-${nodeId}-${aiRev}`,
      type: 'update_node', nodeId, userId,
      baseRevision: aiRev - 1,
      payload: { intent: ai.intent, intentConfidence: ai.confidence, intentSource: 'ai' },
      timestamp: Date.now(), revision: aiRev,
    };
    this.opLog.push(aiOp);
    for (const peer of this.conns) {
      this.send(peer.ws, { type: 'op_broadcast', revision: aiRev, op: aiOp });
    }
    await this.upsertTask(nodeId, userId, text, ai.intent, true);
    for (const peer of this.conns) {
      this.send(peer.ws, { type: 'tasks_changed' });
    }
  }

  private async upsertTask(nodeId: string, userId: string, title: string, intentType: string, confirmedByAi: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO tasks (session_id, node_id, author_id, title, intent_type, confirmed_by_ai, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (node_id) DO UPDATE
         SET title = EXCLUDED.title, intent_type = EXCLUDED.intent_type,
             confirmed_by_ai = EXCLUDED.confirmed_by_ai, updated_at = NOW()`,
      [this.sessionId, nodeId, userId, title.slice(0, 500), intentType, confirmedByAi],
    ).catch((err) => { console.error('[SessionRoom] Failed to upsertTask:', err); });
  }

  // ── Admin role push ───────────────────────────────────────────────────────

  pushRoleChange(userId: string, newRole: Role): void {
    for (const conn of this.conns) {
      if (conn.userId === userId) {
        conn.role = newRole;
        this.send(conn.ws, { type: 'role_ack', role: newRole });
      }
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getNodes()    { return Array.from(this.nodes.values()); }
  getRevision() { return this.revision; }
  getOpLog()    { return this.opLog; }
  connCount()   { return this.conns.size; }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private broadcast(data: unknown, exclude?: ClientConn): void {
    for (const peer of this.conns) {
      if (peer === exclude) continue;
      this.send(peer.ws, data);
    }
  }

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

const rooms = new Map<string, SessionRoom>();
export function getRoom(sessionId: string): SessionRoom {
  let room = rooms.get(sessionId);
  if (!room) { room = new SessionRoom(sessionId); rooms.set(sessionId, room); }
  return room;
}
