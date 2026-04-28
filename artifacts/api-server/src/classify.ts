export type IntentType = 'action_item' | 'decision' | 'open_question' | 'reference';

export interface Classification {
  intent: IntentType;
  confidence: number;
  source: 'keyword' | 'ai';
}

export function classifyByKeyword(text: string): Classification {
  const t = (text || '').trim().toLowerCase();
  if (!t) return { intent: 'reference', confidence: 0.1, source: 'keyword' };

  if (/\?\s*$/.test(t) || /^(who|what|when|where|why|how|should we|can we|do we|are we)\b/.test(t)) {
    return { intent: 'open_question', confidence: 0.85, source: 'keyword' };
  }

  if (
    /\b(todo|to-do|to do|task|assign|deadline|due|fix|implement|build|ship|deliver|investigate|action|owner)\b/.test(t) ||
    /^\s*\[\s*\]\s+/.test(t)
  ) {
    return { intent: 'action_item', confidence: 0.9, source: 'keyword' };
  }

  if (/\b(decided|agree(d)?|approved|locked in|conclusion|let's go with|we will use|chosen)\b/.test(t)) {
    return { intent: 'decision', confidence: 0.85, source: 'keyword' };
  }

  return { intent: 'reference', confidence: 0.4, source: 'keyword' };
}

export async function classifyByAI(text: string): Promise<Classification> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return classifyByKeyword(text);

  const prompt = `Classify the following note from a brainstorm whiteboard into exactly one of these intent types:
- action_item: a task, to-do, or someone needs to do something
- decision: a conclusion the team has reached
- open_question: an unresolved question
- reference: factual information, context, or supporting detail

Respond with ONLY one word: action_item | decision | open_question | reference.

Note: """${text.slice(0, 500)}"""`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 8 },
      }),
    });
    if (!res.ok) {
      return classifyByKeyword(text);
    }
    const data: any = await res.json();
    const out = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase();
    const valid: IntentType[] = ['action_item', 'decision', 'open_question', 'reference'];
    if (valid.includes(out as IntentType)) {
      return { intent: out as IntentType, confidence: 0.95, source: 'ai' };
    }
    return classifyByKeyword(text);
  } catch {
    return classifyByKeyword(text);
  }
}
