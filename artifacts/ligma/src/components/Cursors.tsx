import React from 'react';

interface CursorState { userId: string; userName: string; color: string; x: number; y: number; }

export default function Cursors({ states }: { states: Map<string, CursorState> }) {
  return (
    <div className="cursor-host">
      {Array.from(states.values()).map((s) => (
        <div key={s.userId} className="cursor" style={{ left: s.x, top: s.y }}>
          <div className="cursor-dot" style={{ background: s.color }} />
          <div className="cursor-name" style={{ background: s.color }}>{s.userName}</div>
        </div>
      ))}
    </div>
  );
}
