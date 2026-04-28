import React from 'react';
import type { Task } from '../state/types';

const INTENT_LABELS: Record<string, string> = {
  action_item: 'Action Items',
  decision: 'Decisions',
  open_question: 'Open Questions',
  reference: 'References',
};

const INTENT_ICON: Record<string, string> = {
  action_item: '✅',
  decision: '🟢',
  open_question: '❓',
  reference: '📎',
};

function fmt(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

interface Props {
  tasks: Task[];
  onNodeFocus?: (nodeId: string) => void;
}

export default function TaskBoard({ tasks, onNodeFocus }: Props) {
  if (!tasks.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🧠</div>
        <strong>No tasks yet.</strong>
        <div style={{ marginTop: 6 }}>Start writing on sticky notes — AI will classify them automatically.</div>
      </div>
    );
  }

  const groups: Record<string, Task[]> = {};
  for (const t of tasks) (groups[t.intent_type] ??= []).push(t);
  const ORDER = ['action_item', 'decision', 'open_question', 'reference'];

  return (
    <div className="task-list">
      {ORDER.filter((k) => groups[k]?.length).map((intent) => (
        <div key={intent} className="sidebar-section">
          <div className="sidebar-section-title">
            {INTENT_ICON[intent]} {INTENT_LABELS[intent]} ({groups[intent]!.length})
          </div>
          {groups[intent]!.map((t) => (
            <div
              key={t.id}
              className="task-card"
              style={{
                borderLeft: `3px solid ${
                  intent === 'action_item' ? '#c94040'
                  : intent === 'decision' ? '#1f9060'
                  : intent === 'open_question' ? '#a86800'
                  : '#1a6fa8'
                }`,
                cursor: onNodeFocus ? 'pointer' : 'default',
              }}
              onClick={() => onNodeFocus?.(t.node_id)}
              title={onNodeFocus ? 'Click to focus on canvas node' : undefined}
            >
              <div className="task-card-header">
                {t.confirmed_by_ai && <span className="ai-chip">✦ AI verified</span>}
              </div>
              <div className="task-title">{t.title}</div>
              <div className="task-meta" style={{ marginTop: 6 }}>
                {t.author_color && <div className="task-dot" style={{ background: t.author_color }} />}
                {t.author_name && <span style={{ fontSize: 11, color: 'var(--text-sub)' }}>{t.author_name}</span>}
                <span className="task-time">{fmt(t.updated_at)}</span>
                {onNodeFocus && (
                  <span style={{ fontSize: 10, color: 'var(--accent)', marginLeft: 'auto' }}>→ focus</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
