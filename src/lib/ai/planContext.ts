import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Book,
  CanonFact,
  Chapter,
  ChapterOutline,
  ChapterOutlineScene,
  Character,
  Database,
  OutlineBeat,
  Relationship,
  SettingProfile,
  StoryOutlineNode,
  StoryThread,
  TimelineEvent,
  WritingSection
} from '@/lib/types/database';

/**
 * PLAN's own context assembler — deliberately separate from
 * gatherSectionContext (context.ts), which is scoped to "the next writing
 * section within one chapter" and filters characters/settings by whether
 * they're actually mentioned in nearby prose. Planning happens BEFORE prose
 * exists, so there's usually nothing to mention-match against yet: this
 * pulls the book's established canon directly instead, plus whatever
 * outline already exists for this chapter (re-planning / "Update Outline")
 * and how the previous chapter ended. Same "don't send the whole
 * manuscript" discipline as context.ts — capped, targeted reads, never a
 * full-book dump.
 *
 * Layer boundary: this reads STORY CANON (characters/settings/relationships/
 * threads/canon_facts) and the OUTLINE tables, never writing_sections
 * beyond the previous chapter's last section + this chapter's own (if any
 * exist from a prior writing pass being re-planned). It never treats an
 * outline row as canon.
 */

export interface ChapterPlanningContext {
  book: Pick<Book, 'title' | 'genre' | 'pov' | 'tense' | 'description' | 'ai_suggestion_level'>;
  chapter: Pick<Chapter, 'id' | 'title' | 'summary' | 'chapter_number'>;
  previousChapter: Pick<Chapter, 'title' | 'chapter_number'> | null;
  previousChapterEnding: string | null;
  sectionsSoFarInThisChapter: Pick<WritingSection, 'content'>[];
  characters: Character[];
  settings: SettingProfile[];
  relationships: Relationship[];
  activeThreads: StoryThread[];
  canonFacts: CanonFact[];
  recentTimelineEvents: TimelineEvent[];
  existingOutlineNode: Pick<StoryOutlineNode, 'title' | 'purpose'> | null;
  existingChapterOutline:
    | (Pick<ChapterOutline, 'purpose' | 'opening_state' | 'chapter_end_state' | 'continuity_notes'> & {
        scenes: (Pick<ChapterOutlineScene, 'id' | 'title' | 'goal'> & {
          beats: Pick<OutlineBeat, 'id' | 'text' | 'sort_order'>[];
        })[];
      })
    | null;
}

export async function gatherChapterPlanningContext(
  supabase: SupabaseClient<Database>,
  params: { bookId: string; chapterId: string }
): Promise<ChapterPlanningContext> {
  const { bookId, chapterId } = params;

  const [
    { data: book },
    { data: chapter },
    { data: allChapters },
    { data: characters },
    { data: settingsRows },
    { data: relationships },
    { data: currentOutline }
  ] = await Promise.all([
    supabase.from('books').select('title, genre, pov, tense, description, ai_suggestion_level').eq('id', bookId).single(),
    supabase.from('chapters').select('id, title, summary, chapter_number').eq('id', chapterId).single(),
    supabase.from('chapters').select('id, title, chapter_number, sort_order').eq('book_id', bookId).is('archived_at', null).order('sort_order', { ascending: true }),
    supabase.from('characters').select('*').eq('book_id', bookId).limit(30),
    supabase.from('settings').select('*').eq('book_id', bookId).limit(20),
    supabase.from('relationships').select('*').eq('book_id', bookId).limit(20),
    supabase.from('story_outlines').select('id').eq('book_id', bookId).eq('is_current', true).maybeSingle()
  ]);

  const chapters = allChapters ?? [];
  const targetIndex = chapters.findIndex((c) => c.id === chapterId);
  const previousChapterRow = targetIndex > 0 ? chapters[targetIndex - 1] : null;

  const [
    { data: prevSections },
    { data: sectionsSoFar },
    { data: activeThreadsRows },
    { data: canonFacts },
    { data: timelineEvents },
    { data: outlineNode },
    { data: chapterOutline }
  ] = await Promise.all([
    previousChapterRow
      ? supabase
          .from('writing_sections')
          .select('content')
          .eq('chapter_id', previousChapterRow.id)
          .order('sort_order', { ascending: false })
          .limit(1)
      : Promise.resolve({ data: [] as { content: string }[] }),
    supabase.from('writing_sections').select('content').eq('chapter_id', chapterId).order('sort_order', { ascending: true }),
    supabase.from('story_threads').select('*').eq('book_id', bookId).in('status', ['Active', 'Dormant']).limit(15),
    supabase
      .from('canon_facts')
      .select('*')
      .eq('book_id', bookId)
      .eq('canon_status', 'author_canon')
      .order('updated_at', { ascending: false })
      .limit(30),
    supabase.from('timeline_events').select('*').eq('book_id', bookId).order('event_order', { ascending: false }).limit(8),
    currentOutline
      ? supabase
          .from('story_outline_nodes')
          .select('title, purpose')
          .eq('story_outline_id', currentOutline.id)
          .eq('chapter_id', chapterId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('chapter_outlines').select('*').eq('chapter_id', chapterId).eq('is_current', true).maybeSingle()
  ]);

  let existingChapterOutline: ChapterPlanningContext['existingChapterOutline'] = null;
  if (chapterOutline) {
    const { data: scenes } = await supabase
      .from('chapter_outline_scenes')
      .select('*')
      .eq('chapter_outline_id', chapterOutline.id)
      .order('sort_order', { ascending: true });
    const sceneRows = scenes ?? [];
    const scenesWithBeats = await Promise.all(
      sceneRows.map(async (scene) => {
        const { data: beats } = await supabase
          .from('outline_beats')
          .select('id, text, sort_order')
          .eq('chapter_outline_scene_id', scene.id)
          .order('sort_order', { ascending: true });
        return { id: scene.id, title: scene.title, goal: scene.goal, beats: beats ?? [] };
      })
    );
    existingChapterOutline = {
      purpose: chapterOutline.purpose,
      opening_state: chapterOutline.opening_state,
      chapter_end_state: chapterOutline.chapter_end_state,
      continuity_notes: chapterOutline.continuity_notes,
      scenes: scenesWithBeats
    };
  }

  return {
    book: book!,
    chapter: chapter!,
    previousChapter: previousChapterRow
      ? { title: previousChapterRow.title, chapter_number: previousChapterRow.chapter_number }
      : null,
    previousChapterEnding: prevSections?.[0]?.content ?? null,
    sectionsSoFarInThisChapter: sectionsSoFar ?? [],
    characters: characters ?? [],
    settings: settingsRows ?? [],
    relationships: relationships ?? [],
    activeThreads: activeThreadsRows ?? [],
    canonFacts: canonFacts ?? [],
    recentTimelineEvents: timelineEvents ?? [],
    existingOutlineNode: outlineNode ?? null,
    existingChapterOutline
  };
}

/**
 * One recap, two audiences: the array of labeled sections below is
 * rendered as "Where We Are Now" for the author (each section becomes a
 * short block in the UI) AND joined into the system prompt for the
 * planning interview — so what the author sees and what the AI sees are
 * guaranteed to be the same facts, never two descriptions that can drift.
 */
export interface RecapSection {
  label: string;
  text: string;
}

export function buildChapterPlanningRecap(ctx: ChapterPlanningContext): RecapSection[] {
  const sections: RecapSection[] = [];

  sections.push({
    label: 'This book',
    text: `${ctx.book.title} — ${ctx.book.genre ?? 'genre not set'}, ${ctx.book.pov ?? 'POV not set'}, ${ctx.book.tense ?? 'tense not set'}.${
      ctx.book.description ? ` ${ctx.book.description}` : ''
    }`
  });

  sections.push({
    label: `Planning: ${ctx.chapter.title}`,
    text: ctx.chapter.summary ?? 'No chapter summary set yet.'
  });

  if (ctx.previousChapter) {
    sections.push({
      label: `How ${ctx.previousChapter.title} ended`,
      text: ctx.previousChapterEnding ?? '(That chapter has no written content yet either.)'
    });
  } else {
    sections.push({ label: 'Position in the book', text: 'This is the first chapter — there is no previous chapter to pick up from.' });
  }

  if (ctx.sectionsSoFarInThisChapter.length) {
    sections.push({
      label: 'Already written in this chapter',
      text: ctx.sectionsSoFarInThisChapter.map((s) => s.content).join('\n\n')
    });
  }

  if (ctx.characters.length) {
    sections.push({
      label: 'Characters established',
      text: ctx.characters
        .map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}: ${[c.goals, c.fears].filter(Boolean).join('; ') || 'no details yet'}`)
        .join('\n')
    });
  }

  if (ctx.relationships.length) {
    sections.push({
      label: 'Relationships',
      text: ctx.relationships
        .map((r) => `${r.relationship_type ?? 'Relationship'} — ${r.current_status ?? ''}${r.unresolved_tension ? ` (unresolved: ${r.unresolved_tension})` : ''}`)
        .join('\n')
    });
  }

  if (ctx.activeThreads.length) {
    sections.push({
      label: 'Active & dormant story threads',
      text: ctx.activeThreads.map((t) => `${t.title} (${t.status}): ${t.description ?? ''}`).join('\n')
    });
  }

  if (ctx.canonFacts.length) {
    sections.push({
      label: 'Relevant Author Canon',
      text: ctx.canonFacts.map((f) => `[${f.reality_layer !== 'unclassified' ? f.reality_layer : f.subject_type}] ${f.fact}`).join('\n')
    });
  }

  if (ctx.recentTimelineEvents.length) {
    sections.push({
      label: 'Recent timeline',
      text: ctx.recentTimelineEvents
        .map((e) => `${[e.date_text, e.time_text, e.relative_time].filter(Boolean).join(' / ')}: ${e.event_description}`)
        .join('\n')
    });
  }

  if (ctx.existingOutlineNode) {
    sections.push({
      label: 'Already planned for this chapter (book outline)',
      text: ctx.existingOutlineNode.purpose ?? ctx.existingOutlineNode.title
    });
  }

  if (ctx.existingChapterOutline) {
    const eo = ctx.existingChapterOutline;
    const beatLines = eo.scenes
      .map((s) => `Scene: ${s.title}${s.goal ? ` — ${s.goal}` : ''}\n${s.beats.map((b) => `  • ${b.text}`).join('\n')}`)
      .join('\n');
    sections.push({
      label: 'Existing planned outline for this chapter (already planned future beats)',
      text: [eo.purpose, eo.opening_state && `Opens: ${eo.opening_state}`, eo.chapter_end_state && `Ends: ${eo.chapter_end_state}`, beatLines]
        .filter(Boolean)
        .join('\n')
    });
  }

  return sections;
}

export function renderRecapBlock(sections: RecapSection[]): string {
  return sections.map((s) => `${s.label.toUpperCase()}:\n${s.text}`).join('\n\n');
}
