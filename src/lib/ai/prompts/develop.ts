import { MASTER_AI_RULES } from '@/lib/ai/masterRules';
import { renderContextBlock, type SectionContext } from '@/lib/ai/context';
import type { AiInterviewMessage } from '@/lib/types/database';

/**
 * "Develop This" — spec item 8. The Socratic, one-question-at-a-time loop.
 * This is the feature Sydni specifically called out as the product's real
 * differentiator, so it gets its own two-step design rather than reusing
 * "Continue" with different wording:
 *
 *  1. buildDevelopTurnPrompt — plain-text call, one question per turn,
 *     sharpened by the full message history so far. The model is told to
 *     end its reply with a bare "[SUFFICIENT]" marker once it believes
 *     enough is established, rather than asking forever.
 *  2. buildFinishDevelopmentPrompt — structured call, run when the author
 *     hits Finish Interview (or accepts the model's own suggestion to
 *     stop), producing the DEVELOPMENT NOTES summary.
 */

export function buildDevelopTurnPrompt(ctx: SectionContext, seedIdea: string) {
  const system = `${MASTER_AI_RULES}

TASK: The author has a rough idea for this scene and wants to develop it before \
writing. Interview them ONE QUESTION AT A TIME — never more than one question per \
reply. Use their previous answer to decide the next question; each question should \
go more specific than the last, the way a good developmental editor narrows in, \
not a fixed checklist.

Ask about whatever the scene actually needs next: location, who's present, \
emotional state, objective, conflict, revelations, how it might end, continuity \
with what's already established. Skip categories the author has already answered \
or that don't apply.

If the author provides WORKING / NON-CANONICAL MATERIAL, treat it only as a \
speculative starting point for the interview. Do not treat it as manuscript fact, \
Story Canon, or a settled decision unless the author explicitly establishes it \
during this interview.

When you believe there is enough established for the author to write the passage \
(usually after 4-8 exchanges, never fewer than 3), end your reply with a new line \
containing exactly: [SUFFICIENT]
This lets the app offer "Finish Interview" — the author can still keep going if they want more.
Ask only ONE question in every reply. Do not summarize. Do not write any of the scene.`;

  const userMessage = `MANUSCRIPT CONTEXT:\n\n${renderContextBlock(ctx)}\n\nThe author's rough idea for this scene: "${seedIdea}"\n\nAsk your first question.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}

export function continueDevelopConversation(
  ctx: SectionContext,
  seedIdea: string,
  history: AiInterviewMessage[]
) {
  const { system } = buildDevelopTurnPrompt(ctx, seedIdea);
  const messages = [
    { role: 'user' as const, content: `The author's rough idea for this scene: "${seedIdea}"` },
    ...history.map((m) => ({
      role: (m.role === 'author' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content
    }))
  ];
  return { system, messages };
}

export interface DevelopmentNotesResult {
  location: string;
  people_present: string[];
  emotional_state: string;
  scene_objective: string;
  conflict: string;
  revelations: string[];
  possible_ending: string;
  continuity_considerations: string[];
}

export const DEVELOPMENT_NOTES_SCHEMA = {
  type: 'object',
  properties: {
    location: { type: 'string' },
    people_present: { type: 'array', items: { type: 'string' } },
    emotional_state: { type: 'string' },
    scene_objective: { type: 'string' },
    conflict: { type: 'string' },
    revelations: { type: 'array', items: { type: 'string' } },
    possible_ending: { type: 'string' },
    continuity_considerations: { type: 'array', items: { type: 'string' } }
  },
  required: ['location', 'people_present', 'emotional_state', 'scene_objective', 'conflict']
} as const;

export function buildFinishDevelopmentPrompt(
  ctx: SectionContext,
  seedIdea: string,
  history: AiInterviewMessage[]
) {
  const system = `${MASTER_AI_RULES}

TASK: The interview is finished. Summarize what was established into structured \
Development Notes. Use only what the author actually said in this conversation — \
do not add anything they didn't establish. Leave a field empty/omit an item rather \
than inventing one.`;

  const transcript = history.map((m) => `${m.role === 'author' ? 'Author' : 'Editor'}: ${m.content}`).join('\n');
  const userMessage = `MANUSCRIPT CONTEXT:\n\n${renderContextBlock(ctx)}\n\nSCENE IDEA: ${seedIdea}\n\nINTERVIEW TRANSCRIPT:\n${transcript}\n\nProduce the Development Notes now.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
