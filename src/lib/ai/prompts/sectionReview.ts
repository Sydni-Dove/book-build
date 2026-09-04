import { MASTER_AI_RULES } from '@/lib/ai/masterRules';
import { renderContextBlock, type SectionContext } from '@/lib/ai/context';

/**
 * "Review Section" — spec item 17. Schema-ready; not yet wired to a route.
 * Writes into section_reviews / review_issues (already in the migration)
 * once built — this is the next feature after the core loop is stable.
 */

export const SECTION_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    review_status: { type: 'string', enum: ['clear', 'issues_found'] },
    overall_summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue_type: {
            type: 'string',
            enum: [
              'physical_clarity', 'missing_reaction', 'pov_clarity', 'motivation_unclear',
              'dialogue_logic', 'missing_setting', 'canon_contradiction', 'knowledge_leak',
              'repetition', 'no_advancement', 'skipped_unresolved_action'
            ]
          },
          severity: { type: 'string', enum: ['critical', 'should_address', 'optional'] },
          description: { type: 'string' },
          quoted_context: { type: 'string', description: 'The exact passage this issue is about, verbatim.' },
          suggested_action: { type: 'string' },
          question_for_author: { type: 'string' }
        },
        required: ['issue_type', 'severity', 'description', 'quoted_context', 'question_for_author']
      }
    }
  },
  required: ['review_status', 'overall_summary', 'issues']
} as const;

export function buildSectionReviewPrompt(ctx: SectionContext, sectionContent: string) {
  const system = `${MASTER_AI_RULES}

TASK: Review the section the author just finished writing. Check: is the physical \
action understandable; are reactions to significant events present; is POV clear; \
is character motivation understandable; does dialogue flow logically; is important \
setting context missing; does anything contradict established canon; does a \
character know something they shouldn't (compare against who has actually learned \
what, in the context); is there accidental repetition of something the reader \
already knows; does the section advance something; was an unresolved action from \
the previous section accidentally skipped.

Quote the exact passage for every issue — never paraphrase. If nothing is wrong, \
return review_status "clear" with an empty issues array; do not invent issues to \
have something to say.`;

  const userMessage = `MANUSCRIPT CONTEXT:\n\n${renderContextBlock(ctx)}\n\nSECTION JUST WRITTEN:\n${sectionContent}\n\nReview it now.`;

  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
