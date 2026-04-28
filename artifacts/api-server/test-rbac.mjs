import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8080/ws?session=00000000-0000-0000-0000-000000000001');

ws.on('open', () => {
  console.log('Connected to server');
  
  // 1. Identify as Viewer
  ws.send(JSON.stringify({
    type: 'hello',
    userId: 'hacker-1',
    userName: 'Hacker',
    role: 'Viewer',
    color: '#000000'
  }));

  // 2. Try to add a node (should be denied)
  setTimeout(() => {
    console.log('Attempting unauthorized op...');
    ws.send(JSON.stringify({
      type: 'op',
      op: {
        id: 'exploit-1',
        type: 'add_node',
        nodeId: '66666666-6666-6666-6666-666666666666',
        userId: 'hacker-1',
        baseRevision: 0,
        payload: { kind: 'sticky', x: 100, y: 100, text: 'HACKED' },
        timestamp: Date.now()
      }
    }));
  }, 1000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg.type, msg.reason || '');
  if (msg.type === 'denial') {
    console.log('✅ RBAC Enforcement Verified: Server denied unauthorized op.');
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('❌ Test timed out');
  process.exit(1);
}, 5000);
