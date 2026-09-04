import { MASTER_AI_RULES } from '@/lib/ai/masterRules';

/**
 * "Chapter Review" — spec item 19. Schema-ready; not yet wired to a route.
 * MVP scope per the spec: plot movement, character development, continuity,
 * relationships, setting clarity, missing reactions, pacing, repetition,
 * unresolved threads, setup/payoff, reader confusion — a subset of the
 * full 15-category review in the product architecture doc, expanded later.
 */

export const CHAPTER_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    plot_movement: { type: 'string' },
    character_development: { type: 'string' },
    continuity_notes: { type: 'string' },
    relationship_changes: { type: 'string' },
    setting_clarity: { type: 'string' },
    pacing_notes: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'missing_reaction', 'repetition', 'unresolved_thread', 'setup_no_payoff', 'reader_confusion'
            ]
          },
          severity: { type: 'string', enum: ['critical', 'should_address', 'optional'] },
          description: { type: 'string' },
          section_reference: { type: 'string', description: 'Which section/scene this refers to.' }
        },
        required: ['category', 'severity', 'description']
      }
    }
  },
  required: ['plot_movement', 'character_development', 'continuity_notes', 'issues']
} as const;

export function buildChapterReviewPrompt(chapterTitle: string, fullChapterText: string, storyCanonSummary: string) {
  const system = `${MASTER_AI_RULES}

TASK: Run a chapter-level developmental review, once the chapter is marked \
complete. Cover: plot movement, character development, continuity against the \
story canon, relationship changes, setting clarity, missing reactions, pacing, \
repetition, unresolved threads, setup/payoff, and what a reasonable reader would \
be confused by. Separate INTENTIONAL mystery (something withheld on purpose, which \
you can tell because it isn't marked as an established-but-unwritten canon fact) \
from information that's ACCIDENTALLY missing. Every issue links to a section so \
"Fix With Me" can open the right passage.`;

  const userMessage = `CHAPTER: ${chapterTitle}\n\nSTORY CANON SUMMARY:\n${storyCanonSummary}\n\nFULL CHAPTER TEXT:\n${fullChapterText}\n\nRun the chapter review now.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
