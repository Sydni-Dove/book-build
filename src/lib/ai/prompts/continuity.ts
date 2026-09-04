import { MASTER_AI_RULES } from '@/lib/ai/masterRules';

/**
 * Continuity / Setting Memory conflict check — schema-ready; not yet wired
 * to a route. Runs a diff between new prose and a setting's established_facts
 * (or a character's known-facts) and raises the Keep Original / Update Canon /
 * It's Temporary / Not a Conflict prompt described in the product architecture.
 */

export const CONTINUITY_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    has_conflict: { type: 'boolean' },
    conflicting_established_fact: { type: 'string' },
    new_text_says: { type: 'string' },
    explanation: { type: 'string' }
  },
  required: ['has_conflict']
} as const;

export function buildContinuityCheckPrompt(establishedFacts: string[], newSectionText: string, subjectName: string) {
  const system = `${MASTER_AI_RULES}

TASK: Compare the new section text against what's already established about \
"${subjectName}". Flag it ONLY if the new text actually contradicts an established \
fact — never flag a simple absence of detail, and never flag something the author \
has tagged as tentative/AI inference as if it were confirmed canon.`;

  const userMessage = `ESTABLISHED FACTS ABOUT ${subjectName}:\n${establishedFacts.map((f) => `- ${f}`).join('\n')}\n\nNEW SECTION TEXT:\n${newSectionText}\n\nCheck for a conflict now.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
