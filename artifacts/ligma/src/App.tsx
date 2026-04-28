import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { OTClient } from './state/ot-client';
import type { CanvasNode, Role, Task, EventRow } from './state/types';
import { api } from './state/api';
import Canvas from './components/Canvas';
import TaskBoard from './components/TaskBoard';
import EventLog from './components/EventLog';
import ReplayBar from './components/ReplayBar';

// ── Colour palette ──────────────────────────────────────────────────────
const SWATCHES = ['#5b6af7','#e05050','#31a76c','#d4880a','#2c8fd4','#a855f7','#ec4899'];
const DEFAULT_SESSION = '00000000-0000-0000-0000-000000000001';

// ── JoinDialog ──────────────────────────────────────────────────────────
interface JoinInfo { name: string; role: Role; color: string }

function JoinDialog({ onJoin }: { onJoin: (i: JoinInfo) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('Contributor');
  const [color, setColor] = useState(SWATCHES[0]!);

  return (
    <div className="overlay">
      <div className="dialog" style={{ animation: 'pop-in .22s ease' }}>
        <div className="dialog-logo">LIGMA</div>
        <div className="dialog-sub">Let's Integrate Groups, Manage Anything</div>

        <div className="field">
          <label>Your name</label>
          <input
            className="inp"
            placeholder="e.g. Alice"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && onJoin({ name, role, color })}
            autoFocus
          />
        </div>

        <div className="field">
          <label>Role</label>
          <div className="role-row">
            {(['Lead','Contributor','Viewer'] as Role[]).map((r) => (
              <div
                key={r}
                className={`role-opt${role === r ? ' sel' : ''}`}
                onClick={() => setRole(r)}
              >
                {r === 'Lead' ? '👑' : r === 'Contributor' ? '✏️' : '👁'} {r}
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Colour</label>
          <div className="color-row">
            {SWATCHES.map((c) => (
              <div
                key={c}
                className={`swatch${color === c ? ' sel' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <button
          className="btn-join"
          disabled={!name.trim()}
          onClick={() => name.trim() && onJoin({ name: name.trim(), role, color })}
        >
          Join Session →
        </button>
      </div>
    </div>
  );
}

// ── Main App ────────────────────────────────────────────────────────────
export default function App() {
  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [client, setClient] = useState<OTClient | null>(null);

  const [nodes, setNodes] = useState(new Map<string, CanvasNode>());
  const [status, setStatus] = useState<'connecting'|'connected'|'disconnected'>('disconnected');
  const [revision, setRevision] = useState(0);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [replaySeq, setReplaySeq] = useState<number | null>(null);
  const [replayNodes, setReplayNodes] = useState<Map<string, CanvasNode> | null>(null);

  const [denial, setDenial] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<'tasks'|'events'|'users'>('tasks');

  const denialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Bootstrap client on join ────────────────────────────────────────
  const handleJoin = useCallback(async (info: JoinInfo) => {
    setJoinInfo(info);

    // Register / fetch user from server
    let userId: string;
    try {
      const u = await api.users.create(info.name, info.role, info.color);
      userId = u.id;
    } catch {
      userId = uuidv4();
    }

    const c = new OTClient({
      sessionId: DEFAULT_SESSION,
      userId,
      userName: info.name,
      role: info.role,
      color: info.color,
    });

    c.onNodesChange((map) => {
      setNodes(new Map(map));
      setRevision(c.getRevision());
    });

    c.onStatus(setStatus);

    c.onDenial(({ reason }) => {
      setDenial(reason);
      if (denialTimer.current) clearTimeout(denialTimer.current);
      denialTimer.current = setTimeout(() => setDenial(null), 3000);
    });

    c.onTasksChanged(() => {
      api.tasks.list(DEFAULT_SESSION).then(setTasks).catch(() => {});
    });

    c.connect();
    setClient(c);

    // Load tasks & events
    api.tasks.list(DEFAULT_SESSION).then(setTasks).catch(() => {});
    api.events.list(DEFAULT_SESSION).then(setEvents).catch(() => {});

    return () => c.disconnect();
  }, []);

  // Refresh event log periodically
  useEffect(() => {
    if (!joinInfo) return;
    const id = setInterval(() => {
      api.events.list(DEFAULT_SESSION).then(setEvents).catch(() => {});
    }, 8000);
    return () => clearInterval(id);
  }, [joinInfo]);

  // ── Time-travel replay ──────────────────────────────────────────────
  const handleSeek = useCallback(async (seq: number | null) => {
    if (seq === null) {
      setReplaySeq(null);
      setReplayNodes(null);
      return;
    }
    setReplaySeq(seq);
    try {
      const { events: evs } = await api.replay.get(DEFAULT_SESSION, seq);
      // Reconstruct node map by replaying events
      const map = new Map<string, CanvasNode>();
      for (const ev of evs) {
        const payload = (ev.payload ?? {}) as any;
        if (ev.event_type === 'add_node' && ev.node_id) {
          map.set(ev.node_id, { id: ev.node_id, ...payload });
        } else if (ev.event_type === 'update_node' && ev.node_id) {
          const n = map.get(ev.node_id);
          if (n) map.set(ev.node_id, { ...n, ...payload });
        } else if (ev.event_type === 'delete_node' && ev.node_id) {
          map.delete(ev.node_id);
        } else if (ev.event_type === 'lock_node' && ev.node_id) {
          const n = map.get(ev.node_id);
          if (n) map.set(ev.node_id, { ...n, lockedToRole: payload.lockedToRole ?? null });
        }
      }
      setReplayNodes(map);
    } catch { /* ignore */ }
  }, []);

  if (!joinInfo || !client) {
    return <JoinDialog onJoin={handleJoin} />;
  }

  const displayNodes = replayNodes ?? nodes;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <span className="header-logo">LIGMA</span>
        <div className="header-divider" />
        <span className="header-session">Main Brainstorm</span>
        <div className="header-spacer" />
        <div className="header-pill">
          <div className={`status-dot ${status}`} />
          {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}
        </div>
        <div className="header-rev">rev {revision}</div>
        <div className="header-pill" style={{ gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: joinInfo.color }} />
          <strong>{joinInfo.name}</strong>
          <span style={{ opacity: 0.6 }}>·</span>
          <span style={{ color: 'var(--text-sub)' }}>{joinInfo.role}</span>
        </div>
      </header>

      {/* Body */}
      <div className="app-body">
        {/* Canvas */}
        <Canvas
          client={client}
          nodes={nodes}
          role={joinInfo.role}
          replayNodes={replayNodes}
        />

        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-tabs">
            {(['tasks','events','users'] as const).map((t) => (
              <button
                key={t}
                className={`sidebar-tab${sideTab === t ? ' active' : ''}`}
                onClick={() => setSideTab(t)}
              >
                {{ tasks: '🧠 Tasks', events: '📋 Log', users: '👥 Users' }[t]}
              </button>
            ))}
          </div>
          <div className="sidebar-body">
            {sideTab === 'tasks' && <TaskBoard tasks={tasks} />}
            {sideTab === 'events' && <EventLog events={events} />}
            {sideTab === 'users' && (
              <div className="user-list">
                <div className="user-row">
                  <div className="user-avatar" style={{ background: joinInfo.color }}>
                    {joinInfo.name[0]?.toUpperCase()}
                  </div>
                  <span className="user-name">{joinInfo.name} <span style={{ fontSize: 10, color: 'var(--text-sub)' }}>(you)</span></span>
                  <span className={`role-chip ${joinInfo.role}`}>{joinInfo.role}</span>
                </div>
                <div style={{ marginTop: 16, padding: '10px 8px', background: 'var(--surface2)', borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-sub)', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>OT Engine</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {[
                      ['Revision', `#${revision}`],
                      ['Pending ops', '0'],
                      ['Algorithm', 'OT + LWW'],
                      ['Concurrency', 'Optimistic'],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span style={{ color: 'var(--text-sub)' }}>{k}</span>
                        <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Replay bar */}
      <ReplayBar events={events} replaySeq={replaySeq} onSeek={handleSeek} />

      {/* Denial toast */}
      {denial && <div className="denial-toast">⛔ {denial}</div>}
    </div>
  );
}
