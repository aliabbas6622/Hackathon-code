import app from './app.js';
import { logger } from './lib/logger.js';
import http from 'http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { getRoom, type ClientConn } from './sessionRoom.js';

const rawPort = process.env['PORT'];

if (!rawPort) {
  throw new Error('PORT environment variable is required but was not provided.');
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  // Extract sessionId from query string: /ws?session=<id>
  const url = new URL(req.url ?? '/', `http://localhost`);
  const sessionId = url.searchParams.get('session') ?? '00000000-0000-0000-0000-000000000001';

  const room = getRoom(sessionId);

  const conn: ClientConn = {
    ws,
    userId: uuidv4(),
    userName: 'Unknown',
    role: 'Viewer',
    color: '#3b82f6',
    awarenessClientId: Math.floor(Math.random() * 0xffffffff),
  };

  room.attach(conn);

  ws.on('message', (raw) => {
    room.handleMessage(conn, raw.toString()).catch((err) => {
      logger.error({ err }, 'Error handling WS message');
    });
  });

  ws.on('close', () => {
    room.detach(conn);
  });

  ws.on('error', (err) => {
    logger.error({ err }, 'WebSocket error');
    room.detach(conn);
  });
});

server.listen(port, () => {
  logger.info({ port }, 'LIGMA server listening (HTTP + WebSocket)');
});

server.on('error', (err) => {
  logger.error({ err }, 'Server error');
  process.exit(1);
});

// Export room accessor for use in REST routes.
export { getRoom };
