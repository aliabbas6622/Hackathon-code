import React, { useRef, useCallback, useEffect } from 'react';
import type { CanvasNode } from '../state/types';

const NODE_COLORS: Record<string, string> = {
  '#5b6af7': '#5b6af7',
  '#e05050': '#e05050',
  '#31a76c': '#31a76c',
  '#d4880a': '#d4880a',
  '#2c8fd4': '#2c8fd4',
  '#a855f7': '#a855f7',
};

function labelFor(intent: string | null | undefined): string {
  if (!intent) return '';
  return { action_item: 'Action', decision: 'Decision', open_question: 'Question', reference: 'Ref' }[intent] ?? intent;
}

interface Props {
  node: CanvasNode;
  selected: boolean;
  canEdit: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onTextChange: (text: string) => void;
  onDelete: () => void;
  onLock: (role: string | null) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export default function NodeView({
  node, selected, canEdit,
  onPointerDown, onResizeStart,
  onTextChange, onDelete, onLock,
  onContextMenu,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bodyRef.current) return;
    const el = bodyRef.current;
    if (document.activeElement !== el && el.innerText !== node.text) {
      el.innerText = node.text ?? '';
    }
  }, [node.text]);

  const handleInput = useCallback(() => {
    if (bodyRef.current) onTextChange(bodyRef.current.innerText);
  }, [onTextChange]);

  const intentClass = node.intent ? `intent-${node.intent}` : '';
  const accentColor = node.color || '#5b6af7';

  return (
    <div
      className={`canvas-node pop-in${selected ? ' selected' : ''}${node.lockedToRole ? ' locked' : ''}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {/* top colour strip */}
      <div className="node-top" style={{ background: accentColor }} />

      {/* header row */}
      {(node.intent || node.lockedToRole) && (
        <div className="node-header">
          {node.intent && (
            <span className={`node-intent-badge ${intentClass}`}>
              {labelFor(node.intent)}
              {node.intentSource === 'ai' ? ' ✦' : ''}
            </span>
          )}
          {node.lockedToRole && (
            <span className="node-lock" title={`Locked to ${node.lockedToRole}`}>🔒</span>
          )}
        </div>
      )}

      {/* editable body */}
      <div
        ref={bodyRef}
        className="node-body"
        contentEditable={canEdit && !node.lockedToRole ? 'true' : 'false'}
        suppressContentEditableWarning
        data-placeholder="Type here…"
        onInput={handleInput}
        onPointerDown={(e) => { if (canEdit) e.stopPropagation(); }}
      />

      {/* actions footer */}
      <div className="node-footer">
        {canEdit && !node.lockedToRole && (
          <button className="node-action danger" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>✕</button>
        )}
      </div>

      {/* resize handle */}
      {canEdit && !node.lockedToRole && (
        <div className="resize-handle" onPointerDown={(e) => { e.stopPropagation(); onResizeStart(e); }} />
      )}
    </div>
  );
}
