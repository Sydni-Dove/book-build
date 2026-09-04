import { MASTER_AI_RULES } from '@/lib/ai/masterRules';

/**
 * "Describe This" — spec item 9. Designed and schema-ready; not yet wired
 * to a route/UI (see README "First functioning build" for sequencing —
 * this comes after Continue + Develop This + Story Canon are stable).
 * Setting is the only category with a full multi-field builder for now.
 */

export type DescribeCategory = 'setting' | 'character' | 'atmosphere' | 'object';

export const DESCRIPTION_MATERIAL_SCHEMA = {
  type: 'object',
  properties: {
    visual: { type: 'array', items: { type: 'string' } },
    sound: { type: 'array', items: { type: 'string' } },
    smell: { type: 'array', items: { type: 'string' } },
    physical_sensation: { type: 'array', items: { type: 'string' } },
    activity: { type: 'array', items: { type: 'string' } },
    mood: { type: 'array', items: { type: 'string' } },
    character_specific: { type: 'array', items: { type: 'string' } },
    ideas: {
      type: 'array',
      minItems: 3,
      maxItems: 7,
      items: { type: 'string' },
      description: 'Short usable fragments/details, never finished prose.'
    }
  },
  required: ['ideas']
} as const;

export function buildSettingBuilderPrompt(answers: Record<string, string>, povCharacter?: string) {
  const system = `${MASTER_AI_RULES}

TASK: The author filled out a Setting Builder. Turn their answers into DESCRIPTION \
MATERIAL — organized fragments and details the author could use, not a finished \
paragraph. Actively drop anything that doesn't serve the scene; the goal is \
restraint, not maximum sensory coverage. If they named "story relevance," let it \
filter everything else you produce.${
    povCharacter ? ` Frame "character-specific observations" from ${povCharacter}'s POV specifically.` : ''
  }`;

  const userMessage = `SETTING BUILDER ANSWERS:\n${Object.entries(answers)
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n\nProduce the description material now.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}

export function buildSampleParagraphPrompt(chosenDetails: string[], voiceNotes?: string) {
  const system = `${MASTER_AI_RULES}

TASK: The author explicitly asked to see a sample paragraph using some of the \
description details they approved. Write ONE short paragraph. Label it clearly \
as a suggestion in your own framing — the app will also label it in the UI. \
${voiceNotes ? `Match this author's established voice: ${voiceNotes}` : 'Keep prose plain and unadorned — avoid literary flourish they did not ask for.'}`;

  const userMessage = `APPROVED DETAILS:\n${chosenDetails.map((d) => `- ${d}`).join('\n')}\n\nWrite the sample paragraph.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
