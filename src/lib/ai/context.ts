import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Book,
  CanonFact,
  Chapter,
  Character,
  Database,
  SettingProfile,
  StoryThread,
  TimelineEvent,
  WritingSection
} from '@/lib/types/database';

/**
 * Context assembly — the answer to "don't send the entire novel to the AI
 * every time" (spec item 11/14). This is deliberately relational + keyword
 * matching, NOT embeddings: for a story canon of the size a single novel
 * has, "which characters/settings/threads are actually in this scene" is a
 * name-matching problem, not a semantic-search problem, and keeping it
 * relational means every fact the AI sees traces back to a row an author
 * can see and edit. pgvector is a fast-follow for full-manuscript search
 * once a book is long enough that keyword matching starts missing things —
 * see README "Future: semantic search" for where it plugs in without
 * touching this file's callers.
 */

export interface SectionContext {
  book: Pick<Book, 'title' | 'genre' | 'pov' | 'tense' | 'description' | 'ai_suggestion_level'>;
  chapter: Pick<Chapter, 'title' | 'summary' | 'chapter_number'>;
  previousSections: Pick<WritingSection, 'title' | 'content' | 'summary'>[];
  currentSection: Pick<WritingSection, 'content' | 'title'> | null;
  mentionedCharacters: Character[];
  mentionedSettings: SettingProfile[];
  activeThreads: StoryThread[];
  relevantCanonFacts: CanonFact[];
  recentTimelineEvents: TimelineEvent[];
}

function extractMentions<T extends { name: string }>(text: string, candidates: T[]): T[] {
  const haystack = text.toLowerCase();
  return candidates.filter((c) => {
    const needle = c.name.trim().toLowerCase();
    if (!needle) return false;
    // whole-token match so "Ash" doesn't match inside "Ashley" by accident
    // and vice versa doesn't over-match short names.
    const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return pattern.test(haystack);
  });
}

export async function gatherSectionContext(
  supabase: SupabaseClient<Database>,
  params: { bookId: string; chapterId: string; currentSectionId?: string }
): Promise<SectionContext> {
  const { bookId, chapterId, currentSectionId } = params;

  const [{ data: book }, { data: chapter }, { data: sections }, { data: characters }, { data: settingsRows }] =
    await Promise.all([
      supabase
        .from('books')
        .select('title, genre, pov, tense, description, ai_suggestion_level')
        .eq('id', bookId)
        .single(),
      supabase
        .from('chapters')
        .select('title, summary, chapter_number')
        .eq('id', chapterId)
        .single(),
      supabase
        .from('writing_sections')
        .select('*')
        .eq('chapter_id', chapterId)
        .order('sort_order', { ascending: true }),
      supabase.from('characters').select('*').eq('book_id', bookId),
      supabase.from('settings').select('*').eq('book_id', bookId)
    ]);

  const allSections = sections ?? [];
  const currentIndex = currentSectionId
    ? allSections.findIndex((s) => s.id === currentSectionId)
    : allSections.length; // "about to write the next one"

  const previousSections = allSections.slice(Math.max(0, currentIndex - 3), Math.max(0, currentIndex));
  const currentSection = currentSectionId ? allSections[currentIndex] ?? null : null;

  const textForMentions = [
    chapter?.summary ?? '',
    ...previousSections.map((s) => s.content),
    currentSection?.content ?? ''
  ].join('\n');

  const mentionedCharacters = extractMentions(textForMentions, characters ?? []);
  const mentionedSettings = extractMentions(textForMentions, settingsRows ?? []);

  const characterIds = mentionedCharacters.map((c) => c.id);

  const [{ data: threadLinks }, { data: canonFacts }, { data: timelineEvents }] = await Promise.all([
    characterIds.length
      ? supabase
          .from('story_thread_characters')
          .select('story_thread_id, story_threads(*)')
          .in('character_id', characterIds)
      : Promise.resolve({ data: [] as { story_threads: StoryThread }[] }),
    supabase
      .from('canon_facts')
      .select('*')
      .eq('book_id', bookId)
      .in('subject_type', ['character', 'setting', 'relationship', 'story_thread', 'book'])
      .order('updated_at', { ascending: false })
      .limit(40),
    supabase
      .from('timeline_events')
      .select('*')
      .eq('book_id', bookId)
      .order('event_order', { ascending: false })
      .limit(5)
  ]);

  const relevantSubjectIds = new Set([
    ...characterIds,
    ...mentionedSettings.map((s) => s.id)
  ]);

  const relevantCanonFacts = (canonFacts ?? []).filter(
    (f) => f.subject_type === 'book' || (f.subject_id && relevantSubjectIds.has(f.subject_id))
  );

  const threadsFromLinks = (threadLinks ?? [])
    .map((l) => (l as unknown as { story_threads: StoryThread }).story_threads)
    .filter(Boolean);

  // If no threads matched by character, fall back to the book's Active
  // threads generally — better a slightly broader context than none.
  let activeThreads = threadsFromLinks.filter((t) => t.status === 'Active' || t.status === 'Dormant');
  if (activeThreads.length === 0) {
    const { data: fallbackThreads } = await supabase
      .from('story_threads')
      .select('*')
      .eq('book_id', bookId)
      .eq('status', 'Active')
      .limit(5);
    activeThreads = fallbackThreads ?? [];
  }

  return {
    book: book!,
    chapter: chapter!,
    previousSections,
    currentSection,
    mentionedCharacters,
    mentionedSettings,
    activeThreads,
    relevantCanonFacts,
    recentTimelineEvents: timelineEvents ?? []
  };
}

/** Renders SectionContext into the plain-text block every prompt module embeds. */
export function renderContextBlock(ctx: SectionContext): string {
  const lines: string[] = [];
  lines.push(`BOOK: ${ctx.book.title} — ${ctx.book.genre ?? 'genre not set'}, ${ctx.book.pov ?? 'POV not set'}, ${ctx.book.tense ?? 'tense not set'}`);
  if (ctx.book.description) lines.push(`Book premise: ${ctx.book.description}`);
  lines.push(`\nCHAPTER: ${ctx.chapter.title}${ctx.chapter.summary ? ` — ${ctx.chapter.summary}` : ''}`);

  if (ctx.previousSections.length) {
    lines.push(`\nPREVIOUS SECTION(S) IN THIS CHAPTER:`);
    ctx.previousSections.forEach((s, i) => lines.push(`[${i + 1}] ${s.content}`));
  }
  if (ctx.currentSection?.content) {
    lines.push(`\nCURRENT SECTION (partially written so far):\n${ctx.currentSection.content}`);
  }

  if (ctx.mentionedCharacters.length) {
    lines.push(`\nCHARACTERS IN THIS SCENE:`);
    ctx.mentionedCharacters.forEach((c) =>
      lines.push(
        `- ${c.name}${c.role ? ` (${c.role})` : ''}: ${[c.personality, c.goals, c.fears]
          .filter(Boolean)
          .join('; ') || 'no story-canon details yet'}`
      )
    );
  }

  if (ctx.mentionedSettings.length) {
    lines.push(`\nSETTING(S) IN THIS SCENE:`);
    ctx.mentionedSettings.forEach((s) =>
      lines.push(`- ${s.name}: ${[s.layout, s.atmosphere].filter(Boolean).join('; ') || 'no profile details yet'}`)
    );
  }

  if (ctx.activeThreads.length) {
    lines.push(`\nACTIVE STORY THREADS TOUCHING THIS SCENE:`);
    ctx.activeThreads.forEach((t) => lines.push(`- ${t.title} (${t.status}): ${t.description ?? ''}`));
  }

  if (ctx.relevantCanonFacts.length) {
    lines.push(
      `\nESTABLISHED CANON (do not contradict; "working_note" is not yet settled — treat it as provisional, not certain; ` +
        `a reality_layer other than physical_event/narrator_confirmed_fact means this was a dream, vision, perception, or ` +
        `interpretation, not necessarily objective manuscript reality):`
    );
    ctx.relevantCanonFacts.forEach((f) => {
      const tags: string[] = [f.canon_status, f.manuscript_status];
      if (f.reality_layer !== 'unclassified') tags.push(f.reality_layer);
      if (f.reader_knowledge) tags.push(f.reader_knowledge);
      lines.push(`- [${tags.join('/')}] ${f.fact}`);
    });
  }

  if (ctx.recentTimelineEvents.length) {
    lines.push(`\nRECENT TIMELINE:`);
    ctx.recentTimelineEvents.forEach((e) =>
      lines.push(`- ${[e.date_text, e.time_text, e.relative_time].filter(Boolean).join(' / ')}: ${e.event_description}`)
    );
  }

  return lines.join('\n');
}
