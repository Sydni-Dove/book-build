import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

/**
 * Deterministic Context-Integrity Trace. Given a section_id, walk the exact
 * relational path the read tools rely on and report what maps to what — so we
 * can prove, before a host ever sees it, that:
 *   requested section → correct chapter → correct book → correct neighbours →
 *   correct chapter outline → correct story-outline node.
 *
 * Read-only, no LLM, no writes. Intended for debugging output and regression
 * tests. It performs its OWN explicit queries (rather than reusing the richer
 * assemblers) precisely so a mismatch between "what the trace sees" and "what a
 * briefing shows" would localize the broken layer instead of hiding it.
 */
export interface SectionContextTrace {
  found: boolean;
  requested_section_id: string;
  book?: { id: string; title: string };
  chapter?: { id: string; chapter_number: number | null; title: string };
  section?: { id: string; title: string | null; status: string; sort_order: number };
  prose_first_150?: string;
  prose_last_150?: string;
  previous_section?: { id: string; title: string | null } | null;
  next_section?: { id: string; title: string | null } | null;
  chapter_outline?: { id: string; purpose: string | null; chapter_end_state: string | null } | null;
  story_outline_node?: { id: string; title: string; purpose: string | null; chapter_id: string | null } | null;
  threads?: { id: string; title: string; status: string }[];
  relationship_ids?: string[];
  canon_fact_ids?: string[];
  notes: string[];
}

const clip = (s: string | null | undefined, n: number, tail = false): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return tail ? t.slice(t.length - n) : t.slice(0, n);
};

export async function traceSectionContext(
  supabase: SupabaseClient<Database>,
  sectionId: string
): Promise<SectionContextTrace> {
  const notes: string[] = [];

  const { data: section } = await supabase
    .from('writing_sections')
    .select('id, title, status, content, sort_order, chapter_id')
    .eq('id', sectionId)
    .maybeSingle();
  if (!section) {
    return { found: false, requested_section_id: sectionId, notes: ['No writing_sections row for this id (or not visible under current auth).'] };
  }

  const { data: chapter } = await supabase
    .from('chapters')
    .select('id, chapter_number, title, book_id')
    .eq('id', section.chapter_id)
    .maybeSingle();
  if (!chapter) {
    return { found: false, requested_section_id: sectionId, notes: ['Section has chapter_id with no matching chapters row — orphaned section.'] };
  }

  const { data: book } = await supabase.from('books').select('id, title').eq('id', chapter.book_id).maybeSingle();

  // Neighbours strictly WITHIN this chapter, by sort_order.
  const { data: siblings } = await supabase
    .from('writing_sections')
    .select('id, title, sort_order')
    .eq('chapter_id', chapter.id)
    .order('sort_order', { ascending: true });
  const ordered = siblings ?? [];
  const idx = ordered.findIndex((s) => s.id === section.id);
  const previous_section = idx > 0 ? { id: ordered[idx - 1]!.id, title: ordered[idx - 1]!.title } : null;
  const next_section = idx >= 0 && idx < ordered.length - 1 ? { id: ordered[idx + 1]!.id, title: ordered[idx + 1]!.title } : null;

  // Chapter outline must belong to THIS chapter.
  const { data: chapterOutline } = await supabase
    .from('chapter_outlines')
    .select('id, purpose, chapter_end_state')
    .eq('chapter_id', chapter.id)
    .eq('is_current', true)
    .maybeSingle();

  // Story-outline node linked to THIS chapter (backfilled chapter_id).
  const { data: outlineNode } = await supabase
    .from('story_outline_nodes')
    .select('id, title, purpose, chapter_id')
    .eq('chapter_id', chapter.id)
    .maybeSingle();
  if (outlineNode && outlineNode.chapter_id !== chapter.id) {
    notes.push('WARNING: story_outline_node.chapter_id does not match the chapter — cross-boundary link.');
  }

  const { data: threads } = await supabase
    .from('story_threads')
    .select('id, title, status')
    .eq('book_id', chapter.book_id)
    .in('status', ['Active', 'Dormant']);

  const { data: rels } = await supabase.from('relationships').select('id').eq('book_id', chapter.book_id);
  const { data: canon } = await supabase.from('canon_facts').select('id').eq('book_id', chapter.book_id).limit(40);

  if (idx === -1) notes.push('WARNING: section not found among its own chapter siblings — selection/relationship inconsistency.');

  return {
    found: true,
    requested_section_id: sectionId,
    book: book ? { id: book.id, title: book.title } : undefined,
    chapter: { id: chapter.id, chapter_number: chapter.chapter_number, title: chapter.title },
    section: { id: section.id, title: section.title, status: section.status, sort_order: section.sort_order },
    prose_first_150: clip(section.content, 150),
    prose_last_150: clip(section.content, 150, true),
    previous_section,
    next_section,
    chapter_outline: chapterOutline
      ? { id: chapterOutline.id, purpose: chapterOutline.purpose, chapter_end_state: chapterOutline.chapter_end_state }
      : null,
    story_outline_node: outlineNode
      ? { id: outlineNode.id, title: outlineNode.title, purpose: outlineNode.purpose, chapter_id: outlineNode.chapter_id }
      : null,
    threads: threads ?? [],
    relationship_ids: (rels ?? []).map((r) => r.id),
    canon_fact_ids: (canon ?? []).map((c) => c.id),
    notes
  };
}
