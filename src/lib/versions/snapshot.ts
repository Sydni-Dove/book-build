import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, ManuscriptVersion, ManuscriptVersionReason } from '@/lib/types/database';

// snapshotManuscript — the ONE code path that creates a manuscript_versions
// row plus its immutable section snapshot. Used by "Save Version" (manual)
// and by Restore's automatic before_restore snapshot, and ready for any
// future before_book_revision / before_import_merge operation. Autosave must
// never call this — a checkpoint is always deliberate.
//
// Runs as the signed-in user through the passed client, so RLS applies: it
// can only ever snapshot a book the caller owns. Callers should still verify
// auth.getUser() first (route convention).
export async function snapshotManuscript(
  supabase: SupabaseClient<Database>,
  params: {
    bookId: string;
    name: string;
    description?: string | null;
    reason: ManuscriptVersionReason;
    userId: string;
  }
): Promise<ManuscriptVersion> {
  const { bookId, name, description = null, reason, userId } = params;

  // Live manuscript, in reading order: chapters by sort_order, then their
  // sections by sort_order. This is the exact state being frozen.
  const { data: chapters, error: chaptersError } = await supabase
    .from('chapters')
    .select('id, chapter_number, title, sort_order')
    .eq('book_id', bookId)
    .order('sort_order', { ascending: true });
  if (chaptersError) throw chaptersError;

  const chapterIds = (chapters ?? []).map((c) => c.id);
  const { data: sections, error: sectionsError } = chapterIds.length
    ? await supabase
        .from('writing_sections')
        .select('id, chapter_id, sort_order, title, content, word_count')
        .in('chapter_id', chapterIds)
        .order('sort_order', { ascending: true })
    : { data: [], error: null };
  if (sectionsError) throw sectionsError;

  const chapterById = new Map((chapters ?? []).map((c) => [c.id, c]));
  const totalWordCount = (sections ?? []).reduce((sum, s) => sum + (s.word_count ?? 0), 0);

  // Next version number for this book. The (book_id, version_number) unique
  // constraint makes any race here fail loudly rather than silently collide.
  const { data: prior } = await supabase
    .from('manuscript_versions')
    .select('version_number')
    .eq('book_id', bookId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersionNumber = (prior?.version_number ?? 0) + 1;

  const { data: version, error: versionError } = await supabase
    .from('manuscript_versions')
    .insert({
      book_id: bookId,
      name,
      description,
      version_number: nextVersionNumber,
      reason,
      word_count: totalWordCount,
      chapter_count: chapters?.length ?? 0,
      created_by: userId
    })
    .select()
    .single();
  if (versionError || !version) throw versionError ?? new Error('Version insert returned no row');

  const sectionRows = (sections ?? []).map((s) => {
    const chapter = chapterById.get(s.chapter_id);
    return {
      manuscript_version_id: version.id,
      source_section_id: s.id,
      chapter_number: chapter?.chapter_number ?? null,
      chapter_title: chapter?.title ?? 'Untitled Chapter',
      scene_title: s.title,
      section_order: s.sort_order,
      content: s.content,
      word_count: s.word_count ?? 0
    };
  });

  if (sectionRows.length) {
    const { error: snapError } = await supabase.from('manuscript_version_sections').insert(sectionRows);
    if (snapError) {
      // Don't leave a headerless version row behind if the content insert
      // fails — the version is meaningless without its sections.
      await supabase.from('manuscript_versions').delete().eq('id', version.id);
      throw snapError;
    }
  }

  return version;
}
