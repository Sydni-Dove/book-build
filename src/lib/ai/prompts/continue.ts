import { MASTER_AI_RULES } from '@/lib/ai/masterRules';
import { renderContextBlock, type SectionContext } from '@/lib/ai/context';

/** "Help Me Continue" — spec item 7. Pre-writing questions before a new section. */

export interface ContinueQuestion {
  question: string;
  basedOn: string[]; // 1-3 short manuscript facts, shown to the author as "Based on:"
}

export const CONTINUE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          basedOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'The specific manuscript facts or canon entries that make this question relevant — not generic reasoning.'
          }
        },
        required: ['question', 'basedOn']
      }
    }
  },
  required: ['questions']
} as const;

export function buildContinuePrompt(ctx: SectionContext) {
  const depthNote =
    ctx.book.ai_suggestion_level === 'deep'
      ? 'This author works at "Deep Development" — it is fine for questions to probe motivation and thematic weight, not just plot facts.'
      : ctx.book.ai_suggestion_level === 'light'
        ? 'This author works at "Light" — keep questions minimal and only ask about things that would otherwise cause a continuity problem.'
        : 'This author works at "Guided" — balance plot, emotional, and craft questions.';

  const system = `${MASTER_AI_RULES}

TASK: The author is about to write the next writing section in their chapter. \
Ask 3-6 questions that help them think through what happens next BEFORE they write it. \
${depthNote}

Every question must be traceable to something specific in the context below — a \
previous action needing a reaction, a character's established fear or goal, an \
active thread, an established canon fact, a setting detail. Do not ask a question \
that would apply to any scene in any novel (e.g. never ask a bare "what happens \
next?"). For every question, name what in the context made you ask it, in "basedOn".

Cover a mix of: physical action, character reaction/motivation, emotional change, \
dialogue direction, setting, unresolved information, scene transition, and time \
progression — but only where the context actually makes that angle relevant. Do \
not force all categories if the scene doesn't call for them.`;

  const userMessage = `MANUSCRIPT CONTEXT:\n\n${renderContextBlock(ctx)}\n\nGenerate the pre-writing questions now.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
