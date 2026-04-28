import React from 'react';
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
      <span className="replay-label">⏱ Time Travel</span>
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
        onClick={() => onSeek(isActive ? null : max - Math.floor(max / 2))}
      >
        {isActive ? 'Exit Replay' : 'Replay'}
      </button>
    </div>
  );
}
