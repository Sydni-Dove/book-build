import { MASTER_AI_RULES } from '@/lib/ai/masterRules';

/**
 * Section + chapter summaries — spec items 12/13. Schema-ready; not yet
 * wired to a route. This is the mechanism that lets Continue/Develop reach
 * back further than the last 1-3 sections without re-reading full text —
 * once built, gatherSectionContext() in context.ts gets a second data
 * source (chapter.summary + older section.summary fields) for anything
 * beyond the immediate window.
 */

export const FACTUAL_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Factual only — events, revelations, decisions. Never prose style or how it was written.'
    }
  },
  required: ['summary']
} as const;

export function buildSectionSummaryPrompt(sectionText: string) {
  const system = `${MASTER_AI_RULES}

TASK: Write a concise, strictly factual summary of this section for later \
continuity lookups — what happened, what was revealed, what changed. Do not \
summarize prose style, tone, or craft.`;

  return {
    system,
    messages: [{ role: 'user' as const, content: `SECTION TEXT:\n${sectionText}\n\nSummarize it now.` }]
  };
}

export function buildChapterSummaryPrompt(sectionSummaries: string[], chapterTitle: string) {
  const system = `${MASTER_AI_RULES}

TASK: Combine these section summaries into one chapter summary covering: major \
events, character changes, relationship changes, new information, unresolved \
threads, newly introduced characters/settings, promises, warnings, and important \
decisions. Factual only.`;

  const userMessage = `CHAPTER: ${chapterTitle}\n\nSECTION SUMMARIES:\n${sectionSummaries.map((s, i) => `[${i + 1}] ${s}`).join('\n')}\n\nWrite the chapter summary now.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
