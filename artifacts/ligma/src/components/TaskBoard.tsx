import React from 'react';
import type { Task } from '../state/types';

const INTENT_LABELS: Record<string, string> = {
  action_item: 'Action',
  decision: 'Decision',
  open_question: 'Question',
  reference: 'Reference',
};

function fmt(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export default function TaskBoard({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🧠</div>
        No tasks yet. Add text to sticky notes — AI will classify them automatically.
      </div>
    );
  }

  const groups: Record<string, Task[]> = {};
  for (const t of tasks) {
    (groups[t.intent_type] ??= []).push(t);
  }

  const ORDER = ['action_item', 'decision', 'open_question', 'reference'];

  return (
    <div className="task-list">
      {ORDER.filter((k) => groups[k]?.length).map((intent) => (
        <div key={intent} className="sidebar-section">
          <div className="sidebar-section-title">{INTENT_LABELS[intent]} ({groups[intent]!.length})</div>
          {groups[intent]!.map((t) => (
            <div key={t.id} className={`task-card intent-${t.intent_type}`} style={{ borderLeft: '3px solid' }}>
              <div className="task-card-header">
                {t.confirmed_by_ai && <span className="ai-chip">✦ AI</span>}
              </div>
              <div className="task-title">{t.title}</div>
              <div className="task-meta" style={{ marginTop: 6 }}>
                {t.author_color && (
                  <div className="task-dot" style={{ background: t.author_color }} />
                )}
                {t.author_name && (
                  <span style={{ fontSize: 11, color: 'var(--text-sub)' }}>{t.author_name}</span>
                )}
                <span className="task-time">{fmt(t.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
