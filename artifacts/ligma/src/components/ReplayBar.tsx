import React from 'react';
import { Play, X, Rewind, History } from 'lucide-react';
import type { EventRow } from '../state/types';

interface Props {
  events: EventRow[];
  replaySeq: number | null;
  onSeek: (seq: number | null) => void;
}

export default function ReplayBar({ events, replaySeq, onSeek }: Props) {
  const max = events.length ? parseInt(events[events.length - 1]!.seq_num, 10) : 0;
  const current = replaySeq ?? max;
  const isActive = replaySeq !== null;

  if (!events.length) return null;

  return (
    <div className="replay-bar">
      <div className="replay-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <History size={14} /> <span className="mobile-hide">Time Travel</span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        value={current}
        onChange={(e) => onSeek(parseInt(e.target.value, 10))}
      />
      <span className="replay-pos">
        {current === max ? 'Live' : `#${current}`}
      </span>
      <button
        className={`replay-btn${isActive ? ' active' : ''}`}
        onClick={() => onSeek(isActive ? null : max)}
      >
        {isActive ? <X size={14} /> : <Play size={14} />}
        <span className="mobile-hide" style={{ marginLeft: 6 }}>{isActive ? 'Exit' : 'Replay'}</span>
      </button>
    </div>
  );
}
