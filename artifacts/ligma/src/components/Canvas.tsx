import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { CanvasNode, Role } from '../state/types';
import type { OTClient } from '../state/ot-client';
import NodeView from './NodeView';
import Cursors from './Cursors';

const PALETTE = ['#5b6af7','#e05050','#31a76c','#d4880a','#2c8fd4','#a855f7','#ec4899'];

type Tool = 'select' | 'sticky' | 'rect' | 'text';

interface CtxMenu { x: number; y: number; nodeId: string }

interface Props {
  client: OTClient;
  nodes: Map<string, CanvasNode>;
  role: Role;
  replayNodes?: Map<string, CanvasNode> | null;
}

export default function Canvas({ client, nodes, role, replayNodes }: Props) {
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [cursors, setCursors] = useState(new Map<string, any>());
  const [colorPick, setColorPick] = useState('#5b6af7');
  const areaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ nodeId: string; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ nodeId: string; ow: number; oh: number; mx: number; my: number } | null>(null);

  const displayNodes = replayNodes ?? nodes;

  useEffect(() => {
    return client.onAwareness((states) => setCursors(new Map(states)));
  }, [client]);

  const canvasCoords = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = areaRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // ── canvas click → add node ────────────────────────────────────────
  const handleCanvasDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setCtxMenu(null);
    if (tool === 'select') { setSelected(null); return; }
    if (role === 'Viewer') return;

    const { x, y } = canvasCoords(e);
    const node = client.addNode({
      kind: tool === 'sticky' ? 'sticky' : tool === 'rect' ? 'rect' : 'text',
      x: x - 80, y: y - 40,
      w: 200, h: 120,
      color: colorPick,
      text: '',
    });
    setSelected(node.id);
    setTool('select');
  }, [tool, role, client, colorPick, canvasCoords]);

  // ── drag node ──────────────────────────────────────────────────────
  const handleNodeDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(nodeId);
    setCtxMenu(null);
    const node = displayNodes.get(nodeId);
    if (!node || node.lockedToRole || role === 'Viewer') return;
    const { x, y } = canvasCoords(e);
    dragRef.current = { nodeId, ox: x - node.x, oy: y - node.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [displayNodes, role, canvasCoords]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      const { x, y } = canvasCoords(e);
      const { nodeId, ox, oy } = dragRef.current;
      client.updateNode(nodeId, { x: Math.max(0, x - ox), y: Math.max(0, y - oy) });
    }
    if (resizeRef.current) {
      const { nodeId, ow, oh, mx, my } = resizeRef.current;
      const { x, y } = canvasCoords(e);
      client.updateNode(nodeId, {
        w: Math.max(80, ow + (x - mx)),
        h: Math.max(60, oh + (y - my)),
      });
    }
    // broadcast cursor
    const { x, y } = canvasCoords(e);
    client.updateCursor(x, y);
  }, [client, canvasCoords]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    resizeRef.current = null;
  }, []);

  // ── resize ─────────────────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.PointerEvent, nodeId: string) => {
    const node = displayNodes.get(nodeId);
    if (!node) return;
    const { x, y } = canvasCoords(e);
    resizeRef.current = { nodeId, ow: node.w, oh: node.h, mx: x, my: y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [displayNodes, canvasCoords]);

  // ── context menu ───────────────────────────────────────────────────
  const handleCtxMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId });
    setSelected(nodeId);
  }, []);

  useEffect(() => {
    const close = () => setCtxMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const ctxNode = ctxMenu ? displayNodes.get(ctxMenu.nodeId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Toolbar */}
      <div className="toolbar" style={{ flexDirection: 'row', width: 'auto', height: 48, alignItems: 'center', padding: '0 12px', gap: 6, borderRight: 'none', borderBottom: '1px solid var(--border)' }}>
        {(['select', 'sticky', 'rect', 'text'] as Tool[]).map((t) => (
          <button
            key={t}
            className={`tool-btn${tool === t ? ' active' : ''}`}
            title={{ select: 'Select (V)', sticky: 'Sticky Note (S)', rect: 'Rectangle (R)', text: 'Text (T)' }[t]}
            onClick={() => setTool(t)}
          >
            {{ select: '↖', sticky: '📌', rect: '▭', text: 'T' }[t]}
          </button>
        ))}
        <div className="toolbar-sep" style={{ width: 1, height: 24, margin: '0 4px' }} />
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => setColorPick(c)}
            style={{
              width: 20, height: 20, borderRadius: '50%', background: c,
              border: colorPick === c ? '2.5px solid var(--text)' : '2.5px solid transparent',
              cursor: 'pointer', padding: 0, flexShrink: 0,
            }}
          />
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-sub)' }}>
          {displayNodes.size} node{displayNodes.size !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Canvas */}
      <div className="canvas-wrap">
        <div
          ref={areaRef}
          className="canvas-area"
          style={{ cursor: tool !== 'select' ? 'crosshair' : 'default' }}
          onPointerDown={handleCanvasDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {Array.from(displayNodes.values()).map((node) => (
            <NodeView
              key={node.id}
              node={node}
              selected={selected === node.id}
              canEdit={role !== 'Viewer' && !replayNodes}
              onPointerDown={(e) => handleNodeDown(e, node.id)}
              onResizeStart={(e) => handleResizeStart(e, node.id)}
              onTextChange={(text) => client.updateNode(node.id, { text })}
              onDelete={() => { client.deleteNode(node.id); setSelected(null); }}
              onLock={(r) => client.lockNode(node.id, r)}
              onContextMenu={(e) => handleCtxMenu(e, node.id)}
            />
          ))}
          <Cursors states={cursors} />
        </div>

        {/* Context menu */}
        {ctxMenu && ctxNode && (
          <div
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {role === 'Lead' && (
              <>
                {ctxNode.lockedToRole ? (
                  <div className="ctx-item" onClick={() => { client.lockNode(ctxMenu.nodeId, null); setCtxMenu(null); }}>
                    🔓 Unlock node
                  </div>
                ) : (
                  <>
                    <div className="ctx-item" onClick={() => { client.lockNode(ctxMenu.nodeId, 'Lead'); setCtxMenu(null); }}>
                      🔒 Lock to Lead
                    </div>
                    <div className="ctx-item" onClick={() => { client.lockNode(ctxMenu.nodeId, 'Contributor'); setCtxMenu(null); }}>
                      🔒 Lock to Contributor+
                    </div>
                  </>
                )}
                <div className="ctx-sep" />
              </>
            )}
            {role !== 'Viewer' && (
              <div className="ctx-item danger" onClick={() => { client.deleteNode(ctxMenu.nodeId); setCtxMenu(null); setSelected(null); }}>
                🗑 Delete node
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
