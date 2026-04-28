import React from 'react';
import type { EventRow } from '../state/types';

function dotClass(type: string): string {
  if (type.includes('add')) return 'add';
  if (type.includes('delete')) return 'del';
  if (type.includes('update') || type.includes('lock')) return 'update';
  if (type.includes('user') || type.includes('connect')) return 'user';
  return '';
}

function fmt(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ''; }
}

function label(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function EventLog({ events }: { events: EventRow[] }) {
  if (!events.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📋</div>
        No events yet. Start collaborating!
      </div>
    );
  }
  return (
    <div className="event-list">
      {[...events].reverse().map((ev) => (
        <div className="event-row" key={ev.id}>
          <div className={`event-dot ${dotClass(ev.event_type)}`} />
          <div className="event-body">
            <div className="event-type">{label(ev.event_type)}</div>
            {ev.node_id && (
              <div className="event-time">{ev.node_id.slice(0, 8)}…</div>
            )}
          </div>
          <div className="event-seq">#{ev.seq_num}</div>
          <div className="event-time">{fmt(ev.timestamp)}</div>
        </div>
      ))}
    </div>
  );
}
