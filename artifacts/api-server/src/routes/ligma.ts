import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '@workspace/db';
import { classifyByAI, classifyByKeyword } from '../classify.js';
import { generateSummary } from '../summary.js';
import { getRoom } from '../sessionRoom.js';
import type { Role } from '../rbac.js';
import { logger } from '../lib/logger.js';

const router = Router();

// ── Sessions ──────────────────────────────────────────────────────────────────

router.get('/sessions', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, created_at FROM sessions ORDER BY created_at`);
    res.json(r.rows);
  } catch (err) {
    logger.error({ err }, 'Error in /sessions');
    res.json([{ id: '00000000-0000-0000-0000-000000000001', name: 'Main Brainstorm', created_at: new Date().toISOString() }]);
  }
});

router.post('/sessions', async (req, res) => {
  try {
    const name = (req.body?.name as string) || 'Untitled';
    const r = await pool.query(
      `INSERT INTO sessions (name) VALUES ($1) RETURNING id, name, created_at`,
      [name],
    );
    res.json(r.rows[0]);
  } catch {
    const name = (req.body?.name as string) || 'Untitled';
    res.json({ id: uuidv4(), name, created_at: new Date().toISOString() });
  }
});

// ── Users ─────────────────────────────────────────────────────────────────────

router.get('/users', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, role, color FROM users ORDER BY name`);
    res.json(r.rows);
  } catch {
    res.json([]);
  }
});

router.post('/users', async (req, res) => {
  const { name, role, color } = req.body || {};
  if (!name || !role) {
    res.status(400).json({ error: 'name and role required' });
    return;
  }
  try {
    const r = await pool.query(
      `INSERT INTO users (name, role, color) VALUES ($1, $2, $3)
       RETURNING id, name, role, color`,
      [name, role, color || '#3b82f6'],
    );
    res.json(r.rows[0]);
  } catch {
    res.json({ id: uuidv4(), name, role, color: color || '#3b82f6' });
  }
});

router.patch('/users/:id', async (req, res) => {
  const { role } = req.body || {};
  if (!role) {
    res.status(400).json({ error: 'role required' });
    return;
  }
  try {
    const r = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, role, color`,
      [role, req.params['id']],
    );
    if (r.rows.length === 0) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    // Push role change to connected WebSocket clients.
    const room = getRoom('00000000-0000-0000-0000-000000000001');
    room.pushRoleChange(req.params['id']!, role as Role);
    res.json(r.rows[0]);
  } catch {
    res.json({ id: req.params['id'], role });
  }
});

// ── Events (append-only log) ──────────────────────────────────────────────────

router.get('/events/:sessionId', async (req, res) => {
  try {
    const limit = Math.min(parseInt((req.query['limit'] as string) || '500', 10), 2000);
    const r = await pool.query(
      `SELECT id, seq_num, event_type, node_id, user_id, payload, timestamp
         FROM events
         WHERE session_id = $1
         ORDER BY seq_num ASC
         LIMIT $2`,
      [req.params['sessionId'], limit],
    );
    res.json(r.rows);
  } catch (err) {
    logger.error({ err, sessionId: req.params['sessionId'] }, 'Error in /events');
    res.json([]);
  }
});

// ── Tasks (intent-extracted) ──────────────────────────────────────────────────

router.get('/tasks/:sessionId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id, t.node_id, t.title, t.intent_type, t.confirmed_by_ai,
              t.created_at, t.updated_at,
              u.name AS author_name, u.color AS author_color
         FROM tasks t
         LEFT JOIN users u ON u.id = t.author_id
         WHERE t.session_id = $1
         ORDER BY t.updated_at DESC`,
      [req.params['sessionId']],
    );
    res.json(r.rows);
  } catch (err) {
    logger.error({ err, sessionId: req.params['sessionId'] }, 'Error in /tasks');
    res.json([]);
  }
});

// ── Time-Travel Replay ────────────────────────────────────────────────────────

router.get('/replay/:sessionId', async (req, res) => {
  try {
    const seq = parseInt((req.query['seq'] as string) || '999999999', 10);
    const r = await pool.query(
      `SELECT id, seq_num, event_type, node_id, user_id, payload, timestamp
         FROM events
         WHERE session_id = $1 AND seq_num <= $2
         ORDER BY seq_num ASC`,
      [req.params['sessionId'], seq],
    );
    res.json({ events: r.rows });
  } catch (err) {
    logger.error({ err, sessionId: req.params['sessionId'], seq: req.query['seq'] }, 'Error in /replay');
    res.json({ events: [] });
  }
});

// ── AI Classify (direct endpoint) ────────────────────────────────────────────

router.post('/classify', async (req, res) => {
  const { text } = req.body || {};
  if (!text) {
    res.status(400).json({ error: 'text required' });
    return;
  }
  const result = await classifyByAI(String(text));
  res.json(result);
});

// ── AI Summary Export ─────────────────────────────────────────────────────────

router.get('/summary/:sessionId', async (req, res) => {
  try {
    const summary = await generateSummary(req.params['sessionId']!);
    res.json(summary);
  } catch (err) {
    logger.error({ err, sessionId: req.params['sessionId'] }, 'Failed to generate summary');
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ── Room snapshot (for debugging/REST consumers) ──────────────────────────────

router.get('/room/:sessionId/state', (req, res) => {
  const room = getRoom(req.params['sessionId']!);
  res.json({
    sessionId: req.params['sessionId'],
    revision: room.getRevision(),
    nodeCount: room.getNodes().length,
    connCount: room.connCount(),
    nodes: room.getNodes(),
  });
});

export default router;
