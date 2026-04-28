import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { OTClient } from './state/ot-client';
import type { CanvasNode, Role, Task, EventRow, HeatmapData } from './state/types';
import { api } from './state/api';
import Canvas from './components/Canvas';
import TaskBoard from './components/TaskBoard';
import EventLog from './components/EventLog';
import ReplayBar from './components/ReplayBar';

const SWATCHES = ['#5b6af7','#e05050','#31a76c','#d4880a','#2c8fd4','#a855f7','#ec4899'];
const DEFAULT_SESSION = '00000000-0000-0000-0000-000000000001';

interface JoinInfo { name: string; role: Role; color: string; userId: string }

// ── Join Dialog ──────────────────────────────────────────────────────────────
function JoinDialog({ onJoin }: { onJoin: (i: JoinInfo) => void }) {
  const [name, setName]   = useState('');
  const [role, setRole]   = useState<Role>('Contributor');
  const [color, setColor] = useState(SWATCHES[0]!);
  const [loading, setLoading] = useState(false);

  const join = async () => {
    if (!name.trim() || loading) return;
    setLoading(true);
    let userId: string;
    try {
      const u = await api.users.create(name.trim(), role, color);
      userId = u.id;
    } catch {
      userId = uuidv4();
    }
    onJoin({ name: name.trim(), role, color, userId });
  };

  return (
    <div className="overlay">
      <div className="dialog" style={{ animation: 'pop-in .22s ease' }}>
        <div className="dialog-logo">LIGMA</div>
        <div className="dialog-sub">Let's Integrate Groups, Manage Anything</div>

        <div className="field">
          <label>Your name</label>
          <input className="inp" placeholder="e.g. Alice" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && join()} autoFocus />
        </div>

        <div className="field">
          <label>Role</label>
          <div className="role-row">
            {(['Lead', 'Contributor', 'Viewer'] as Role[]).map((r) => (
              <div key={r} className={`role-opt${role === r ? ' sel' : ''}`} onClick={() => setRole(r)}>
                {{ Lead: '👑', Contributor: '✏️', Viewer: '👁' }[r]} {r}
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Colour</label>
          <div className="color-row">
            {SWATCHES.map((c) => (
              <div key={c} className={`swatch${color === c ? ' sel' : ''}`}
                style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>

        <button className="btn-join" disabled={!name.trim() || loading} onClick={join}>
          {loading ? 'Joining…' : 'Join Session →'}
        </button>

        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-sub)', textAlign: 'center' }}>
          Open multiple tabs to test real-time collaboration
        </div>
      </div>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [client, setClient]     = useState<OTClient | null>(null);

  const [nodes,    setNodes]    = useState(new Map<string, CanvasNode>());
  const [status,   setStatus]   = useState<'connecting'|'connected'|'disconnected'>('disconnected');
  const [revision, setRevision] = useState(0);

  const [tasks,   setTasks]   = useState<Task[]>([]);
  const [events,  setEvents]  = useState<EventRow[]>([]);

  const [replaySeq,   setReplaySeq]   = useState<number | null>(null);
  const [replayNodes, setReplayNodes] = useState<Map<string, CanvasNode> | null>(null);

  const [denial,   setDenial]   = useState<string | null>(null);
  const [sideTab,  setSideTab]  = useState<'tasks'|'events'|'users'>('tasks');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(false);

  const denialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Heatmap data: count edits per node ───────────────────────────────────
  const heatmap: HeatmapData = useMemo(() => {
    const map = new Map<string, number>();
    for (const ev of events) {
      if (ev.node_id && (ev.event_type === 'update_node' || ev.event_type === 'add_node')) {
        map.set(ev.node_id, (map.get(ev.node_id) ?? 0) + 1);
      }
    }
    return map;
  }, [events]);

  // ── Join handler ─────────────────────────────────────────────────────────
  const handleJoin = useCallback((info: JoinInfo) => {
    setJoinInfo(info);

    const c = new OTClient({
      sessionId: DEFAULT_SESSION,
      userId: info.userId,
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

    api.tasks.list(DEFAULT_SESSION).then(setTasks).catch(() => {});
    api.events.list(DEFAULT_SESSION).then(setEvents).catch(() => {});
  }, []);

  // ── Periodically refresh events/tasks ────────────────────────────────────
  useEffect(() => {
    if (!joinInfo) return;
    const id = setInterval(() => {
      api.events.list(DEFAULT_SESSION).then(setEvents).catch(() => {});
      api.tasks.list(DEFAULT_SESSION).then(setTasks).catch(() => {});
    }, 6000);
    return () => clearInterval(id);
  }, [joinInfo]);

  // ── Time-travel replay ────────────────────────────────────────────────────
  const handleSeek = useCallback(async (seq: number | null) => {
    if (seq === null) { setReplaySeq(null); setReplayNodes(null); return; }
    setReplaySeq(seq);
    try {
      const { events: evs } = await api.replay.get(DEFAULT_SESSION, seq);
      const map = new Map<string, CanvasNode>();
      for (const ev of evs) {
        const p = (ev.payload ?? {}) as any;
        if (ev.event_type === 'add_node' && ev.node_id)
          map.set(ev.node_id, { id: ev.node_id, kind: p.kind ?? 'sticky', x: p.x ?? 0, y: p.y ?? 0, w: p.w ?? 200, h: p.h ?? 120, color: p.color ?? '#5b6af7', text: p.text ?? '', ...p });
        else if (ev.event_type === 'update_node' && ev.node_id) {
          const n = map.get(ev.node_id);
          if (n) map.set(ev.node_id, { ...n, ...p });
        } else if (ev.event_type === 'delete_node' && ev.node_id)
          map.delete(ev.node_id);
        else if (ev.event_type === 'lock_node' && ev.node_id) {
          const n = map.get(ev.node_id);
          if (n) map.set(ev.node_id, { ...n, lockedToRole: p.lockedToRole ?? null });
        }
      }
      setReplayNodes(map);
    } catch { /* ignore */ }
  }, []);

  // ── Node focus from task board ────────────────────────────────────────────
  const handleNodeFocus = useCallback((nodeId: string) => {
    setFocusNodeId(nodeId);
    // Clear after Canvas consumes it
    setTimeout(() => setFocusNodeId(null), 500);
  }, []);

  // ── Pending op count ──────────────────────────────────────────────────────
  const pendingCount = 0; // Would wire into OTClient if we expose it

  if (!joinInfo || !client) return <JoinDialog onJoin={handleJoin} />;

  const connectedPeers = Array.from(client.getCursorStates().values());

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <span className="header-logo">LIGMA</span>
        <div className="header-divider" />
        <span className="header-session">Main Brainstorm</span>
        <div className="header-spacer" />

        {/* Heatmap toggle */}
        <button
          className="tool-btn"
          title={showHeatmap ? 'Hide heatmap' : 'Show presence heatmap'}
          style={showHeatmap ? { background: 'rgba(249,115,22,.1)', color: '#f97316', borderColor: '#f97316' } : {}}
          onClick={() => setShowHeatmap((v) => !v)}
        >🔥</button>

        <div className="header-pill">
          <div className={`status-dot ${status}`} />
          {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}
        </div>
        <div className="header-rev">rev {revision}</div>
        <div className="header-pill" style={{ gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: joinInfo.color }} />
          <strong>{joinInfo.name}</strong>
          <span style={{ opacity: .5 }}>·</span>
          <span style={{ color: 'var(--text-sub)' }}>{joinInfo.role}</span>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="app-body">
        {/* Canvas */}
        <Canvas
          client={client}
          nodes={nodes}
          role={joinInfo.role}
          replayNodes={replayNodes}
          focusNodeId={focusNodeId}
          heatmap={heatmap}
          showHeatmap={showHeatmap}
        />

        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-tabs">
            {(['tasks','events','users'] as const).map((t) => (
              <button key={t} className={`sidebar-tab${sideTab === t ? ' active' : ''}`}
                onClick={() => setSideTab(t)}>
                {{ tasks: '🧠 Tasks', events: '📋 Log', users: '👥 Users' }[t]}
              </button>
            ))}
          </div>
          <div className="sidebar-body">
            {sideTab === 'tasks' && (
              <TaskBoard tasks={tasks} onNodeFocus={handleNodeFocus} />
            )}
            {sideTab === 'events' && (
              <EventLog events={events} />
            )}
            {sideTab === 'users' && (
              <div className="user-list">
                <div className="sidebar-section-title">In this session</div>
                <div className="user-row">
                  <div className="user-avatar" style={{ background: joinInfo.color }}>
                    {joinInfo.name[0]?.toUpperCase()}
                  </div>
                  <span className="user-name">{joinInfo.name}
                    <span style={{ fontSize: 10, color: 'var(--text-sub)', marginLeft: 4 }}>(you)</span>
                  </span>
                  <span className={`role-chip ${joinInfo.role}`}>{joinInfo.role}</span>
                </div>
                {connectedPeers.map((p: any) => (
                  <div key={p.userId} className="user-row">
                    <div className="user-avatar" style={{ background: p.color }}>
                      {(p.userName?.[0] ?? '?').toUpperCase()}
                    </div>
                    <span className="user-name">{p.userName}</span>
                  </div>
                ))}

                {/* OT engine panel */}
                <div style={{ marginTop: 20, padding: '12px', background: 'var(--surface2)', borderRadius: 10, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-sub)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
                    OT Engine
                  </div>
                  {[
                    ['Algorithm', 'OT + LWW'],
                    ['Revision', `#${revision}`],
                    ['Concurrency', 'Optimistic'],
                    ['Conflict', 'Field-level merge'],
                    ['Broadcast', 'Delta ops only'],
                    ['Events', `${events.length}`],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                      <span style={{ color: 'var(--text-sub)' }}>{k}</span>
                      <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{v}</span>
                    </div>
                  ))}
                </div>

                {/* Heatmap toggle */}
                <button
                  onClick={() => setShowHeatmap((v) => !v)}
                  style={{
                    marginTop: 12, width: '100%', padding: '8px',
                    background: showHeatmap ? 'rgba(249,115,22,.1)' : 'var(--surface2)',
                    border: `1px solid ${showHeatmap ? '#f97316' : 'var(--border)'}`,
                    borderRadius: 8, color: showHeatmap ? '#f97316' : 'var(--text-dim)',
                    cursor: 'pointer', fontWeight: 600, fontSize: 12,
                  }}
                >
                  🔥 {showHeatmap ? 'Hide' : 'Show'} Presence Heatmap
                </button>
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
