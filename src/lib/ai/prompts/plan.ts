import { MASTER_AI_RULES } from '@/lib/ai/masterRules';
import { renderRecapBlock, type RecapSection } from '@/lib/ai/planContext';
import type { AiInterviewMessage } from '@/lib/types/database';

/**
 * PLAN — plot & outline development, upstream of writing. Distinct from the
 * writing AI (Develop This / Help Me Continue): PLAN decides what should
 * happen, those help write it once it's known.
 *
 * Layer boundary, restated in every PLAN prompt below: STORY CANON is what
 * is true, OUTLINE is what is planned, MANUSCRIPT is what has actually been
 * written. Nothing planned here becomes canon merely by being planned —
 * that only happens if the author later adds it to Story Canon by hand, the
 * same as any other Working Note.
 */

const PLAN_RULES = `${MASTER_AI_RULES}

PLAN-SPECIFIC RULES:
- You are helping the author DECIDE what happens, not writing it. Never draft manuscript prose here, even a sample paragraph — that belongs to Develop This / Help Me Continue once the plan exists.
- You may recommend a story structure (three-act, hero's journey, save-the-cat, etc.) if it fits, but never silently impose one — "unstructured" is a first-class, permanent choice if that's what suits the story.
- If something planned seems to create a plot hole or contradiction, raise it as a QUESTION for the author to consider ("Would X still make sense given Y?"), never as a flat declaration that something is wrong.
- Nothing you produce becomes Author Canon automatically. It stays a plan until the author writes it or explicitly promotes a fact to Story Canon.`;

// ============================================================================
// "Build My Story" — new-book guided interview (interview_type: plan_new_book)
// ============================================================================

export function buildNewBookInterviewTurn(bookTitle: string, seedIdea: string) {
  const system = `${PLAN_RULES}

TASK: The author is starting to plan a new book from scratch. Interview them ONE QUESTION AT A TIME — never more than one question per reply — to draw out premise, central conflict, protagonist, stakes, and the shape of the story. Use their previous answer to decide the next question, narrowing in like a developmental editor, not a fixed checklist.

When you believe there is enough established to propose real Plot Possibilities (usually after 4-7 exchanges, never fewer than 3), end your reply with a new line containing exactly: [SUFFICIENT]
Ask only ONE question in every reply. Do not summarize. Do not propose possibilities yet — that's a separate step.`;

  const userMessage = `BOOK: ${bookTitle}\n\nThe author's starting idea: "${seedIdea}"\n\nAsk your first question.`;
  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}

export function continueNewBookInterview(bookTitle: string, seedIdea: string, history: AiInterviewMessage[]) {
  const { system } = buildNewBookInterviewTurn(bookTitle, seedIdea);
  const messages = [
    { role: 'user' as const, content: `The author's starting idea: "${seedIdea}"` },
    ...history.map((m) => ({ role: (m.role === 'author' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content }))
  ];
  return { system, messages };
}

export interface PlotPossibility {
  title: string;
  premise: string;
  pros: string[];
  cons: string[];
}

export const PLOT_POSSIBILITIES_SCHEMA = {
  type: 'object',
  properties: {
    possibilities: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short, distinct name for this direction — not a generic label.' },
          premise: { type: 'string', description: '2-4 sentences: what actually happens in this direction.' },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'premise', 'pros', 'cons']
      }
    }
  },
  required: ['possibilities']
} as const;

export function buildPlotPossibilitiesPrompt(bookTitle: string, seedIdea: string, history: AiInterviewMessage[]) {
  const system = `${PLAN_RULES}

TASK: Based on the interview so far, propose 3-5 GENUINELY DIFFERENT directions for this story — not variations on one idea. Each must be a real fork (different central conflict, different ending shape, different what-the-book-is-actually-about), not a cosmetic reskin of the others. For each, give honest pros and cons — cons are required, not decorative. Do not rank or recommend one over the others; the author decides. None of these become canon by being listed — they're possibilities, not decisions.`;

  const transcript = history.map((m) => `${m.role === 'author' ? 'Author' : 'Editor'}: ${m.content}`).join('\n');
  const userMessage = `BOOK: ${bookTitle}\n\nSTARTING IDEA: ${seedIdea}\n\nINTERVIEW TRANSCRIPT:\n${transcript}\n\nPropose the plot possibilities now.`;
  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}

export interface BookOutlineChapter {
  title: string;
  purpose: string;
}
export interface BookOutlineAct {
  title: string;
  purpose?: string;
  chapters: BookOutlineChapter[];
}
export interface BookOutlineResult {
  structure_type: 'three_act' | 'four_act' | 'heros_journey' | 'save_the_cat' | 'mystery' | 'romance' | 'custom' | 'unstructured';
  structure_type_note?: string;
  acts: BookOutlineAct[];
}

export const BOOK_OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    structure_type: {
      type: 'string',
      enum: ['three_act', 'four_act', 'heros_journey', 'save_the_cat', 'mystery', 'romance', 'custom', 'unstructured']
    },
    structure_type_note: { type: 'string', description: 'Only if structure_type is custom, or a brief note on why this structure fits.' },
    acts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          purpose: { type: 'string' },
          chapters: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, purpose: { type: 'string' } },
              required: ['title', 'purpose']
            }
          }
        },
        required: ['title', 'chapters']
      }
    }
  },
  required: ['structure_type', 'acts']
} as const;

export function buildBookOutlinePrompt(
  bookTitle: string,
  seedIdea: string,
  history: AiInterviewMessage[],
  chosenPossibility: PlotPossibility
) {
  const system = `${PLAN_RULES}

TASK: The author chose a direction. Turn it into a book-level outline: Acts, and the Chapters within each Act, each with a one-to-two-sentence purpose (what that chapter needs to accomplish, not its prose). Recommend a structure_type only if the story genuinely fits one — 'unstructured' is correct and preferred over forcing a mismatched template. This is a skeleton for planning, not a chapter-by-chapter summary of events that spoils the whole book — purposes should describe function ("establishes X," "forces Y to choose") more than plot beats.`;

  const transcript = history.map((m) => `${m.role === 'author' ? 'Author' : 'Editor'}: ${m.content}`).join('\n');
  const userMessage = `BOOK: ${bookTitle}\n\nSTARTING IDEA: ${seedIdea}\n\nINTERVIEW TRANSCRIPT:\n${transcript}\n\nCHOSEN DIRECTION: ${chosenPossibility.title}\n${chosenPossibility.premise}\n\nBuild the book outline now.`;
  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}

// ============================================================================
// "Plan This Chapter" — chapter-level guided interview (interview_type: plan_chapter)
// ============================================================================

export function buildChapterInterviewTurn(recap: RecapSection[]) {
  const system = `${PLAN_RULES}

TASK: The author is planning this chapter before writing it. Interview them ONE QUESTION AT A TIME — never more than one per reply — to establish the chapter's purpose, its opening state, what changes by the end, and what scenes/beats get it there. Use their previous answer to decide the next question. Ground every question in the "Where We Are Now" context below — do not ask a question that ignores established canon or the previous chapter's ending.

If re-planning a chapter that already has an outline, treat the existing plan as a starting point to revise, not something to ignore.

When you believe there is enough established to write a Detailed Chapter Outline (usually after 3-6 exchanges, never fewer than 2), end your reply with a new line containing exactly: [SUFFICIENT]
Ask only ONE question in every reply. Do not write any manuscript prose.`;

  const userMessage = `WHERE WE ARE NOW:\n\n${renderRecapBlock(recap)}\n\nAsk your first question about this chapter.`;
  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}

export function continueChapterInterview(recap: RecapSection[], history: AiInterviewMessage[]) {
  const { system } = buildChapterInterviewTurn(recap);
  const messages = [
    { role: 'user' as const, content: `WHERE WE ARE NOW:\n\n${renderRecapBlock(recap)}` },
    ...history.map((m) => ({ role: (m.role === 'author' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content }))
  ];
  return { system, messages };
}

export interface ChapterOutlineBeatResult {
  title: string;
  goal?: string;
  beats: string[];
}
export interface ChapterOutlineResult {
  purpose: string;
  opening_state?: string;
  chapter_end_state?: string;
  new_questions_created?: string;
  continuity_notes?: string;
  open_questions?: string[];
  scenes: ChapterOutlineBeatResult[];
}

export const CHAPTER_OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    purpose: { type: 'string', description: 'What this chapter needs to accomplish.' },
    opening_state: { type: 'string' },
    chapter_end_state: { type: 'string' },
    new_questions_created: { type: 'string', description: 'What this chapter deliberately leaves open for later.' },
    continuity_notes: { type: 'string' },
    open_questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Anything that might create a plot hole or contradiction, phrased as a question for the author — never as a flat statement that something is wrong.'
    },
    scenes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          goal: { type: 'string' },
          beats: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Small story movements, in order — not full prose.' }
        },
        required: ['title', 'beats']
      }
    }
  },
  required: ['purpose', 'scenes']
} as const;

export function buildChapterOutlinePrompt(recap: RecapSection[], history: AiInterviewMessage[]) {
  const system = `${PLAN_RULES}

TASK: The chapter-planning interview is finished. Produce a Detailed Chapter Outline: purpose, opening state, end state, continuity notes, any open questions (phrased as questions), and the scenes with their beats. Beats are small movements ("she notices the letter is missing," not a paragraph of prose) — a reorderable list the author can edit, not manuscript text. Use only what the author actually established in this conversation and the context below; do not invent plot points they didn't establish.`;

  const transcript = history.map((m) => `${m.role === 'author' ? 'Author' : 'Editor'}: ${m.content}`).join('\n');
  const userMessage = `WHERE WE ARE NOW:\n\n${renderRecapBlock(recap)}\n\nINTERVIEW TRANSCRIPT:\n${transcript}\n\nProduce the Detailed Chapter Outline now.`;
  return { system, messages: [{ role: 'user' as const, content: userMessage }] };
}
