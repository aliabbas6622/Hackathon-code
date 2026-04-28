import { pool } from '@workspace/db';

export interface SummarySection {
  title: string;
  items: Array<{ text: string; author?: string; nodeId: string; timestamp: string }>;
}

export interface SessionSummary {
  sessionName: string;
  generatedAt: string;
  totalNodes: number;
  totalEvents: number;
  sections: {
    decisions: SummarySection;
    action_items: SummarySection;
    open_questions: SummarySection;
    references: SummarySection;
  };
  aiNarrative: string | null;
  source: 'ai' | 'structured';
}

interface TaskRow {
  title: string;
  intent_type: string;
  node_id: string;
  updated_at: string;
  author_name: string | null;
}

async function buildStructured(sessionId: string): Promise<SessionSummary> {
  const [tasksRes, sessionRes, eventsRes] = await Promise.all([
    pool.query<TaskRow>(
      `SELECT t.title, t.intent_type, t.node_id, t.updated_at, u.name AS author_name
       FROM tasks t LEFT JOIN users u ON u.id = t.author_id
       WHERE t.session_id = $1 ORDER BY t.updated_at`,
      [sessionId],
    ),
    pool.query<{ name: string }>(
      `SELECT name FROM sessions WHERE id = $1`, [sessionId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM events WHERE session_id = $1`, [sessionId],
    ),
  ]);

  const tasks = tasksRes.rows;
  const sessionName = sessionRes.rows[0]?.name ?? 'Session';
  const totalEvents = parseInt(eventsRes.rows[0]?.count ?? '0', 10);

  const toSection = (intent: string, title: string): SummarySection => ({
    title,
    items: tasks
      .filter((t) => t.intent_type === intent)
      .map((t) => ({
        text: t.title,
        author: t.author_name ?? undefined,
        nodeId: t.node_id,
        timestamp: t.updated_at,
      })),
  });

  return {
    sessionName,
    generatedAt: new Date().toISOString(),
    totalNodes: tasks.length,
    totalEvents,
    sections: {
      decisions:      toSection('decision',      '✅ Decisions Made'),
      action_items:   toSection('action_item',   '📋 Action Items'),
      open_questions: toSection('open_question', '❓ Open Questions'),
      references:     toSection('reference',     '📎 References & Context'),
    },
    aiNarrative: null,
    source: 'structured',
  };
}

export async function generateSummary(sessionId: string): Promise<SessionSummary> {
  const structured = await buildStructured(sessionId);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return structured;

  // Flatten all tasks into a readable prompt
  const allItems = [
    ...structured.sections.decisions.items.map((i) => `[DECISION] ${i.text}`),
    ...structured.sections.action_items.items.map((i) => `[ACTION] ${i.text}${i.author ? ` (owner: ${i.author})` : ''}`),
    ...structured.sections.open_questions.items.map((i) => `[QUESTION] ${i.text}`),
    ...structured.sections.references.items.map((i) => `[REFERENCE] ${i.text}`),
  ];

  if (!allItems.length) return structured;

  const prompt = `You are a meeting facilitator summarising a brainstorm session called "${structured.sessionName}".
Below is the structured output extracted from the collaborative whiteboard:

${allItems.join('\n')}

Write a concise executive narrative (3–5 sentences) that:
1. States the key decisions made.
2. Highlights the most important action items and who owns them.
3. Flags any unresolved open questions that need follow-up.
4. Closes with a brief statement about what happens next.

Be direct and professional. Do not use bullet points — write in prose.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
      }),
    });

    if (res.ok) {
      const data: any = await res.json();
      const narrative = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
      if (narrative) {
        return { ...structured, aiNarrative: narrative.trim(), source: 'ai' };
      }
    }
  } catch { /* fall back to structured */ }

  return structured;
}
