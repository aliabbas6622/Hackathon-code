import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { CanvasNode, Role, HeatmapData } from '../state/types';
import type { OTClient } from '../state/ot-client';
import NodeView from './NodeView';
import Cursors from './Cursors';
import HeatmapOverlay from './HeatmapOverlay';

const PALETTE = ['#5b6af7','#e05050','#31a76c','#d4880a','#2c8fd4','#a855f7','#ec4899','#0f766e'];
export type Tool = 'select' | 'sticky' | 'rect' | 'text' | 'draw' | 'connect';

interface CtxMenu { sx: number; sy: number; nodeId: string }
interface ConnectState { fromId: string }
interface DrawState { pts: Array<[number,number]> }

interface Props {
  client: OTClient;
  nodes: Map<string, CanvasNode>;
  role: Role;
  replayNodes?: Map<string, CanvasNode> | null;
  focusNodeId?: string | null;
  heatmap: HeatmapData;
  showHeatmap: boolean;
}

// ── Edge SVG layer ──────────────────────────────────────────────────────────
function EdgeLayer({ nodes }: { nodes: Map<string, CanvasNode> }) {
  const edges = useMemo(
    () => Array.from(nodes.values()).filter((n) => n.kind === 'edge'),
    [nodes],
  );
  if (!edges.length) return null;

  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}>
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="var(--border2)" />
        </marker>
      </defs>
      {edges.map((e) => {
        const src = nodes.get(e.srcId ?? '');
        const dst = nodes.get(e.dstId ?? '');
        if (!src || !dst || src.kind === 'edge' || dst.kind === 'edge') return null;
        const x1 = src.x + src.w / 2, y1 = src.y + src.h / 2;
        const x2 = dst.x + dst.w / 2, y2 = dst.y + dst.h / 2;
        return (
          <line key={e.id} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={e.color || 'var(--border2)'} strokeWidth={2}
            strokeDasharray="5,3" markerEnd="url(#arrowhead)" />
        );
      })}
    </svg>
  );
}

// ── Ghost edge while connecting ─────────────────────────────────────────────
function GhostEdge({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 95 }}>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
        stroke="var(--accent)" strokeWidth={2} strokeDasharray="6,3" opacity={0.7} />
    </svg>
  );
}

export default function Canvas({ client, nodes, role, replayNodes, focusNodeId, heatmap, showHeatmap }: Props) {
  // ── Camera ──────────────────────────────────────────────────────────
  const [pan, setPan]   = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(1);

  // ── Tool & selection ────────────────────────────────────────────────
  const [tool, setTool]       = useState<Tool>('sticky');
  const [selected, setSelected] = useState<string | null>(null);
  const [color, setColor]     = useState(PALETTE[0]!);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [cursors, setCursors] = useState(new Map<string, any>());
  const [ghostMouse, setGhostMouse] = useState({ x: 0, y: 0 });

  // ── Drag refs ───────────────────────────────────────────────────────
  const dragRef   = useRef<{ nodeId: string; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ nodeId: string; ow: number; oh: number; mx: number; my: number } | null>(null);
  const panRef    = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const spaceRef  = useRef(false);
  const drawRef   = useRef<DrawState | null>(null);
  const connectRef = useRef<ConnectState | null>(null);

  const areaRef = useRef<HTMLDivElement>(null);
  const displayNodes = replayNodes ?? nodes;

  // ── Sync cursors ────────────────────────────────────────────────────
  useEffect(() => client.onAwareness((s) => setCursors(new Map(s))), [client]);

  // ── Focus node (from task board click) ─────────────────────────────
  useEffect(() => {
    if (!focusNodeId) return;
    const node = displayNodes.get(focusNodeId);
    if (!node) return;
    const el = areaRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPan({
      x: width / 2 - (node.x + node.w / 2) * zoom,
      y: height / 2 - (node.y + node.h / 2) * zoom,
    });
    setSelected(focusNodeId);
  }, [focusNodeId]); // eslint-disable-line

  // ── Coord helpers ───────────────────────────────────────────────────
  const screenToWorld = useCallback((sx: number, sy: number) => ({
    x: (sx - pan.x) / zoom,
    y: (sy - pan.y) / zoom,
  }), [pan, zoom]);

  const screenCoords = useCallback((e: { clientX: number; clientY: number }) => {
    const r = areaRef.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }, []);

  // ── Space = pan mode ────────────────────────────────────────────────
  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = true; };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = false; };
    const del = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected &&
        !(document.activeElement?.getAttribute('contenteditable'))) {
        client.deleteNode(selected);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('keydown', del);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('keydown', del); };
  }, [selected, client]);

  // ── Wheel → zoom ────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const { sx, sy } = screenCoords(e);
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => {
      const nz = Math.min(3, Math.max(0.2, z * delta));
      setPan((p) => ({
        x: sx - (sx - p.x) * (nz / z),
        y: sy - (sy - p.y) * (nz / z),
      }));
      return nz;
    });
  }, [screenCoords]);

  // ── Canvas pointer down ─────────────────────────────────────────────
  const handleCanvasDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    setCtxMenu(null);

    const { sx, sy } = screenCoords(e);
    const world = screenToWorld(sx, sy);

    // Middle button or space → pan
    if (e.button === 1 || spaceRef.current) {
      panRef.current = { sx, sy, px: pan.x, py: pan.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    // Draw tool
    if (tool === 'draw') {
      drawRef.current = { pts: [[world.x, world.y]] };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    // Select → deselect
    if (tool === 'select') { setSelected(null); return; }

    // Connect tool — started from canvas = cancel
    if (tool === 'connect') { connectRef.current = null; return; }

    // Add node
    if (role === 'Viewer') return;
    const node = client.addNode({
      kind: tool === 'sticky' ? 'sticky' : tool === 'rect' ? 'rect' : 'text',
      x: world.x - 100, y: world.y - 60,
      w: 200, h: 120,
      color,
      text: '',
      createdAt: Date.now(),
    });
    setSelected(node.id);
    setTool('select');
  }, [tool, role, client, color, pan, zoom, screenCoords, screenToWorld]);

  // ── Node pointer down ───────────────────────────────────────────────
  const handleNodeDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setCtxMenu(null);

    const node = displayNodes.get(nodeId);
    const { sx, sy } = screenCoords(e);
    const world = screenToWorld(sx, sy);

    // Connect tool: first click sets source, second sets destination
    if (tool === 'connect') {
      if (!connectRef.current) {
        connectRef.current = { fromId: nodeId };
        setSelected(nodeId);
      } else {
        if (connectRef.current.fromId !== nodeId && role !== 'Viewer') {
          const src = displayNodes.get(connectRef.current.fromId);
          client.addNode({
            kind: 'edge',
            srcId: connectRef.current.fromId,
            dstId: nodeId,
            x: 0, y: 0, w: 0, h: 0,
            color: color,
            text: '',
          });
        }
        connectRef.current = null;
        setTool('select');
      }
      return;
    }

    setSelected(nodeId);

    if (!node || node.lockedToRole || role === 'Viewer') return;
    if (tool !== 'select') return;

    dragRef.current = { nodeId, ox: world.x - node.x, oy: world.y - node.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [displayNodes, role, client, color, tool, screenCoords, screenToWorld]);

  // ── Pointer move ────────────────────────────────────────────────────
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const { sx, sy } = screenCoords(e);
    const world = screenToWorld(sx, sy);

    setGhostMouse({ x: sx, y: sy });

    if (panRef.current) {
      const { sx: osx, sy: osy, px, py } = panRef.current;
      setPan({ x: px + (sx - osx), y: py + (sy - osy) });
      return;
    }

    if (drawRef.current) {
      drawRef.current.pts.push([world.x, world.y]);
      // Force re-render by creating a new array ref? We'll update on pointerUp.
      return;
    }

    if (dragRef.current) {
      const { nodeId, ox, oy } = dragRef.current;
      client.updateNode(nodeId, { x: Math.max(0, world.x - ox), y: Math.max(0, world.y - oy) });
    }

    if (resizeRef.current) {
      const { nodeId, ow, oh, mx, my } = resizeRef.current;
      client.updateNode(nodeId, {
        w: Math.max(80, ow + (world.x - mx)),
        h: Math.max(60, oh + (world.y - my)),
      });
    }

    // Broadcast cursor in world space
    client.updateCursor(world.x, world.y);
  }, [client, screenCoords, screenToWorld]);

  // ── Pointer up ──────────────────────────────────────────────────────
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    panRef.current = null;
    dragRef.current = null;
    resizeRef.current = null;

    if (drawRef.current && drawRef.current.pts.length > 2) {
      const pts = drawRef.current.pts;
      const xs = pts.map(([x]) => x);
      const ys = pts.map(([, y]) => y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const maxX = Math.max(...xs), maxY = Math.max(...ys);
      client.addNode({
        kind: 'draw',
        x: minX, y: minY,
        w: Math.max(20, maxX - minX),
        h: Math.max(20, maxY - minY),
        color, text: '',
        points: pts,
      });
      setTool('select');
    }
    drawRef.current = null;
  }, [client, color]);

  // ── Resize start ────────────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.PointerEvent, nodeId: string) => {
    const node = displayNodes.get(nodeId);
    if (!node) return;
    const { sx, sy } = screenCoords(e);
    const world = screenToWorld(sx, sy);
    resizeRef.current = { nodeId, ow: node.w, oh: node.h, mx: world.x, my: world.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [displayNodes, screenCoords, screenToWorld]);

  // ── Context menu ────────────────────────────────────────────────────
  const handleCtxMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    setCtxMenu({ sx: e.clientX, sy: e.clientY, nodeId });
    setSelected(nodeId);
  }, []);

  useEffect(() => {
    const close = () => setCtxMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const ctxNode = ctxMenu ? displayNodes.get(ctxMenu.nodeId) : null;

  // ── Cursor positions in screen space ────────────────────────────────
  const screenCursors = useMemo(() => {
    const map = new Map<string, any>();
    for (const [id, s] of cursors) {
      map.set(id, { ...s, x: s.x * zoom + pan.x, y: s.y * zoom + pan.y });
    }
    return map;
  }, [cursors, pan, zoom]);

  const toolDefs: Array<{ id: Tool; icon: string; label: string }> = [
    { id: 'select',  icon: '↖',  label: 'Select (V)' },
    { id: 'sticky',  icon: '📌', label: 'Sticky (S)' },
    { id: 'rect',    icon: '▭',  label: 'Rectangle (R)' },
    { id: 'text',    icon: 'T',  label: 'Text (T)' },
    { id: 'draw',    icon: '✏️', label: 'Draw (D)' },
    { id: 'connect', icon: '↔',  label: 'Connect (C)' },
  ];

  const isReadonly = !!replayNodes;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: 'var(--bg)' }}>

      {/* ── Toolbar strip ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '6px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        {toolDefs.map(({ id, icon, label }) => (
          <button key={id} title={label}
            className={`tool-btn${tool === id ? ' active' : ''}`}
            onClick={() => { setTool(id); connectRef.current = null; }}
          >{icon}</button>
        ))}

        <div style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 6px' }} />

        {PALETTE.map((c) => (
          <button key={c} onClick={() => setColor(c)} style={{
            width: 20, height: 20, borderRadius: '50%', background: c, border: 'none',
            outline: color === c ? '2.5px solid var(--text)' : '2.5px solid transparent',
            cursor: 'pointer', flexShrink: 0,
          }} />
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {connectRef.current && (
            <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
              🔗 Click destination node…
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-sub)' }}>
            {zoom !== 1 ? `${Math.round(zoom * 100)}%` : ''} {displayNodes.size} obj
          </span>
          <button className="tool-btn" title="Reset view" onClick={() => { setPan({ x: 40, y: 40 }); setZoom(1); }}>⌂</button>
        </div>
      </div>

      {/* ── Canvas ── */}
      <div ref={areaRef} style={{ flex: 1, position: 'relative', overflow: 'hidden',
        background: 'var(--bg)',
        backgroundImage: 'radial-gradient(circle, var(--border) 1.2px, transparent 1.2px)',
        backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
        cursor: spaceRef.current ? 'grab' : tool === 'draw' ? 'crosshair' : tool === 'connect' ? 'cell' : 'default',
      }}
        onPointerDown={handleCanvasDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* World transform container */}
        <div style={{ position: 'absolute', inset: 0, transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>

          {/* Edges */}
          <EdgeLayer nodes={displayNodes} />

          {/* Nodes */}
          {Array.from(displayNodes.values())
            .filter((n) => n.kind !== 'edge')
            .map((node) => (
              <NodeView
                key={node.id}
                node={node}
                selected={selected === node.id}
                canEdit={role !== 'Viewer' && !isReadonly}
                zoom={zoom}
                onPointerDown={(e) => handleNodeDown(e, node.id)}
                onResizeStart={(e) => handleResizeStart(e, node.id)}
                onTextChange={(text) => client.updateNode(node.id, { text })}
                onDelete={() => { client.deleteNode(node.id); setSelected(null); }}
                onLock={(r) => client.lockNode(node.id, r)}
                onContextMenu={(e) => handleCtxMenu(e, node.id)}
              />
            ))}
        </div>

        {/* Heatmap overlay (in screen space — uses pre-transformed coords from component) */}
        {showHeatmap && (
          <HeatmapOverlay nodes={displayNodes} heatmap={heatmap} panX={pan.x} panY={pan.y} zoom={zoom} />
        )}

        {/* Peer cursors (screen space) */}
        <Cursors states={screenCursors} />

        {/* Ghost edge while connecting */}
        {connectRef.current && (() => {
          const srcNode = displayNodes.get(connectRef.current.fromId);
          if (!srcNode) return null;
          const fx = (srcNode.x + srcNode.w / 2) * zoom + pan.x;
          const fy = (srcNode.y + srcNode.h / 2) * zoom + pan.y;
          return <GhostEdge from={{ x: fx, y: fy }} to={ghostMouse} />;
        })()}

        {/* Replay label */}
        {isReadonly && (
          <div style={{ position: 'absolute', top: 10, left: 10, background: 'var(--warn)', color: '#fff', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            ⏱ Replay mode — read only
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && ctxNode && (
        <div className="ctx-menu" style={{ left: ctxMenu.sx, top: ctxMenu.sy }}
          onPointerDown={(e) => e.stopPropagation()}>
          {role === 'Lead' && (
            <>
              {ctxNode.lockedToRole ? (
                <div className="ctx-item" onClick={() => { client.lockNode(ctxMenu.nodeId, null); setCtxMenu(null); }}>
                  🔓 Unlock node
                </div>
              ) : (
                <>
                  <div className="ctx-item" onClick={() => { client.lockNode(ctxMenu.nodeId, 'Lead'); setCtxMenu(null); }}>
                    🔒 Lock to Lead only
                  </div>
                  <div className="ctx-item" onClick={() => { client.lockNode(ctxMenu.nodeId, 'Contributor'); setCtxMenu(null); }}>
                    🔒 Lock to Contributor+
                  </div>
                </>
              )}
              <div className="ctx-sep" />
            </>
          )}
          <div className="ctx-item" onClick={() => {
            setTool('connect'); connectRef.current = { fromId: ctxMenu.nodeId }; setCtxMenu(null);
          }}>↔ Connect to…</div>
          <div className="ctx-sep" />
          {role !== 'Viewer' && (
            <div className="ctx-item danger" onClick={() => {
              client.deleteNode(ctxMenu.nodeId); setCtxMenu(null); setSelected(null);
            }}>🗑 Delete</div>
          )}
        </div>
      )}
    </div>
  );
}
