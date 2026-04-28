import React, { useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { X, Lock, Unlock, Sparkles, Trash2 } from 'lucide-react';
import type { CanvasNode } from '../state/types';

function intentLabel(intent: string | null | undefined): string {
  if (!intent) return '';
  return { action_item: 'Action', decision: 'Decision', open_question: 'Question', reference: 'Ref' }[intent] ?? intent;
}

interface Props {
  node: CanvasNode;
  selected: boolean;
  canEdit: boolean;
  zoom: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onTextChange: (text: string) => void;
  onDelete: () => void;
  onLock: (role: string | null) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

// ── Draw node ─────────────────────────────────────────────────────────────────
function DrawNode({ node, selected, onPointerDown, onDelete, canEdit }: {
  node: CanvasNode; selected: boolean; canEdit: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDelete: () => void;
}) {
  if (!node.points?.length) return null;
  const xs = node.points.map(([x]) => x);
  const ys = node.points.map(([, y]) => y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const pts = node.points.map(([x, y]) => `${x - minX},${y - minY}`).join(' ');

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      className={`canvas-node${selected ? ' selected' : ''}`}
      style={{
        left: node.x, top: node.y, width: node.w, height: node.h,
        background: 'transparent', border: selected ? '1.5px dashed var(--accent)' : '1.5px dashed transparent',
        boxShadow: 'none', cursor: 'move',
      }}
      onPointerDown={onPointerDown}
    >
      <svg width={node.w} height={node.h} style={{ display: 'block' }}>
        <polyline points={pts} fill="none" stroke={node.color} strokeWidth={2.5}
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {canEdit && selected && (
        <button
          className="node-action danger"
          style={{ position: 'absolute', top: -12, right: -12, opacity: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '50%', width: 20, height: 20, fontSize: 10, display: 'flex', alignItems: 'center', justifyCenter: 'center', padding: 0 }}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <X size={10} />
        </button>
      )}
    </motion.div>
  );
}

// ── Regular node ──────────────────────────────────────────────────────────────
export default function NodeView({ node, selected, canEdit, zoom, onPointerDown, onResizeStart, onTextChange, onDelete, onLock, onContextMenu }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  if (node.kind === 'draw') {
    return (
      <DrawNode node={node} selected={selected} canEdit={canEdit}
        onPointerDown={onPointerDown} onDelete={onDelete} />
    );
  }

  if (node.kind === 'edge') return null; // edges rendered by Canvas SVG layer

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!bodyRef.current) return;
    const el = bodyRef.current;
    if (document.activeElement !== el && el.innerText !== (node.text ?? '')) {
      el.innerText = node.text ?? '';
    }
  }, [node.text]);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const handleInput = useCallback(() => {
    if (bodyRef.current) onTextChange(bodyRef.current.innerText);
  }, [onTextChange]);

  const accentColor = node.color || '#5b6af7';
  const intentClass = node.intent ? `intent-${node.intent}` : '';
  const editable = canEdit && !node.lockedToRole;

  return (
    <motion.div
      layoutId={node.id}
      initial={{ opacity: 0, scale: 0.85, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.7, filter: 'blur(4px)' }}
      transition={{ type: 'spring', damping: 20, stiffness: 250 }}
      className={`canvas-node${selected ? ' selected' : ''}${node.lockedToRole ? ' locked' : ''}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {/* top colour bar */}
      <div style={{ height: 4, background: accentColor, borderRadius: '10px 10px 0 0', flexShrink: 0 }} />

      {/* header */}
      {(node.intent || node.lockedToRole) && (
        <div className="node-header">
          {node.intent && (
            <span className={`node-intent-badge ${intentClass}`}>
              {node.intentSource === 'ai' && <Sparkles size={10} style={{ marginRight: 4 }} />}
              {intentLabel(node.intent)}
            </span>
          )}
          {node.lockedToRole && <span className="node-lock"><Lock size={10} style={{ marginRight: 2 }} /> {node.lockedToRole}</span>}
        </div>
      )}

      {/* body */}
      <div
        ref={bodyRef}
        className="node-body"
        contentEditable={editable ? 'true' : 'false'}
        suppressContentEditableWarning
        data-placeholder={node.kind === 'text' ? 'Text…' : 'Type here…'}
        onInput={handleInput}
        onPointerDown={(e) => { if (editable) e.stopPropagation(); }}
        style={node.kind === 'text' ? { fontWeight: 500, fontSize: 15 } : undefined}
      />

      {/* footer */}
      <div className="node-footer">
        {editable && (
          <button className="node-action danger" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* resize */}
      {editable && (
        <div className="resize-handle" onPointerDown={(e) => { e.stopPropagation(); onResizeStart(e); }} />
      )}
    </motion.div>
  );
}
