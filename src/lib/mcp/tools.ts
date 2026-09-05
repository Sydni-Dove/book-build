import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, StoryThread, ChapterSnapshot } from '@/lib/types/database';
import { gatherSectionContext, renderContextBlock } from '@/lib/ai/context';
import { gatherChapterPlanningContext } from '@/lib/ai/planContext';
import { analyzeStoryState, type AnalyzeInput } from '@/lib/ai/development/analyzeStoryState';
import { analyzeSectionProse, computeVoiceBaseline, splitParagraphs } from '@/lib/ai/development/proseSignals';
import { computeLineDiff } from '@/lib/versions/diff';
import { parseManuscript } from '@/lib/ingest/parseManuscript';
import { computeContinuityFindings, type FindingCandidate } from '@/lib/ai/review/continuity';
import { buildDeepReviewDigest, verifyAiCandidates, verifyAiCandidatesDetailed, sanitizeHostCandidates, MAX_HOST_CANDIDATES, DEEP_REVIEW_SYSTEM, DEEP_REVIEW_SCHEMA, type DeepInput, type RawAiResult, type RawAiCandidate } from '@/lib/ai/review/deepReview';
import { callOpenAIStructured } from '@/lib/ai/client';
import { isAiUsageLimitError } from '@/lib/ai/usage';
import { computeVoiceConsistency, type VoiceSectionInput } from '@/lib/ai/review/voiceConsistency';
import { computePhrasing, type PhrasingSectionInput } from '@/lib/ai/review/phrasing';
import {
  selectActiveModules,
  buildGuidanceText,
  type MethodologyModuleId
} from '@/lib/ai/methodology/modules';

// Every tool returns MCP tool-result shape. We ALSO fold the structured data
// into the text block as JSON so the data reaches the host model regardless of
// whether the client renders structuredContent — important for portability
// across Claude and ChatGPT. No tool in this file ever calls an LLM.
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
};

type SB = SupabaseClient<Database>;

function ok(summary: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(structured, null, 2)}` }],
    structuredContent: structured
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message } };
}

// --- 1. list_books ----------------------------------------------------------
export async function listBooks(supabase: SB): Promise<ToolResult> {
  const { data, error } = await supabase
    .from('books')
    .select('id, title, subtitle, status, updated_at')
    .order('updated_at', { ascending: false });
  if (error) return fail(`Could not list books: ${error.message}`);
  return ok(`${data?.length ?? 0} book(s).`, { books: data ?? [] });
}

// --- 2. list_chapters -------------------------------------------------------
export async function listChapters(supabase: SB, args: { book_id: string }): Promise<ToolResult> {
  const { data, error } = await supabase
    .from('chapters')
    .select('id, chapter_number, title, status, sort_order')
    .eq('book_id', args.book_id)
    .is('archived_at', null)
    .order('sort_order', { ascending: true });
  if (error) return fail(`Could not list chapters: ${error.message}`);
  return ok(`${data?.length ?? 0} chapter(s).`, { chapters: data ?? [] });
}

// --- 3. list_sections -------------------------------------------------------
export async function listSections(supabase: SB, args: { chapter_id: string }): Promise<ToolResult> {
  const { data, error } = await supabase
    .from('writing_sections')
    .select('id, sort_order, title, status, word_count, content')
    .eq('chapter_id', args.chapter_id)
    .order('sort_order', { ascending: true });
  if (error) return fail(`Could not list sections: ${error.message}`);
  const sections = (data ?? []).map((s) => ({
    id: s.id,
    sort_order: s.sort_order,
    title: s.title,
    status: s.status,
    word_count: s.word_count,
    preview: (s.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  }));
  return ok(`${sections.length} section(s).`, { sections });
}

// Resolve a section id up to its chapter and book (needed by the context tools).
async function resolveSection(
  supabase: SB,
  sectionId: string
): Promise<{ section: { id: string; chapter_id: string; title: string | null; content: string; word_count: number; status: string }; chapterId: string; bookId: string } | null> {
  const { data: section } = await supabase
    .from('writing_sections')
    .select('id, chapter_id, title, content, word_count, status')
    .eq('id', sectionId)
    .maybeSingle();
  if (!section) return null;
  const { data: chapter } = await supabase
    .from('chapters')
    .select('id, book_id')
    .eq('id', section.chapter_id)
    .maybeSingle();
  if (!chapter) return null;
  return { section, chapterId: chapter.id, bookId: chapter.book_id };
}

// --- 4. get_writing_context -------------------------------------------------
export async function getWritingContext(supabase: SB, args: { section_id: string }): Promise<ToolResult> {
  const resolved = await resolveSection(supabase, args.section_id);
  if (!resolved) return fail('Section not found (or not yours).');
  const ctx = await gatherSectionContext(supabase, {
    bookId: resolved.bookId,
    chapterId: resolved.chapterId,
    currentSectionId: resolved.section.id
  });
  const context_text = renderContextBlock(ctx);
  return ok('Assembled section writing context (deterministic; no LLM).', {
    section_id: resolved.section.id,
    context_text,
    structured: {
      book: ctx.book,
      chapter: ctx.chapter,
      previous_sections: ctx.previousSections,
      current_section: ctx.currentSection,
      characters: ctx.mentionedCharacters.map((c) => ({ name: c.name, role: c.role })),
      settings: ctx.mentionedSettings.map((s) => ({ name: s.name })),
      active_threads: ctx.activeThreads.map((t) => ({ title: t.title, status: t.status })),
      canon_facts: ctx.relevantCanonFacts.map((f) => ({ fact: f.fact, canon_status: f.canon_status })),
      recent_timeline: ctx.recentTimelineEvents.map((e) => ({ event: e.event_description }))
    },
    meta: { llm_used: false, source: 'gatherSectionContext' }
  });
}

// --- 5. get_section_draft ---------------------------------------------------
export async function getSectionDraft(supabase: SB, args: { section_id: string }): Promise<ToolResult> {
  const { data: section, error } = await supabase
    .from('writing_sections')
    .select('id, title, content, word_count, status, updated_at')
    .eq('id', args.section_id)
    .maybeSingle();
  if (error) return fail(`Could not read draft: ${error.message}`);
  if (!section) return fail('Section not found (or not yours).');
  return ok(`Draft for "${section.title ?? 'Untitled section'}" (${section.word_count} words).`, { draft: section });
}

// --- 6. get_development_briefing --------------------------------------------
export async function getDevelopmentBriefing(
  supabase: SB,
  args: { section_id: string; focus?: AnalyzeFocus }
): Promise<ToolResult> {
  const focus: AnalyzeFocus = args.focus ?? 'auto';
  const resolved = await resolveSection(supabase, args.section_id);
  if (!resolved) return fail('Section not found (or not yours).');
  const { bookId, chapterId } = resolved;

  // Reuse the existing planning-context assembler for the narrative pieces.
  const ctx = await gatherChapterPlanningContext(supabase, { bookId, chapterId });

  // A few targeted, deterministic selects for the signal inputs.
  const [{ data: book }, { data: chapterIndex }, { data: threads }, { data: chapterOutline }, { data: excerptRows }] =
    await Promise.all([
      supabase
        .from('books')
        .select('title, genre, target_audience, pov, tense, description, author_notes')
        .eq('id', bookId)
        .maybeSingle(),
      supabase.from('chapters').select('id, chapter_number, sort_order').eq('book_id', bookId).is('archived_at', null),
      // ALL threads: analyzeStoryState surfaces only Active/Dormant as
      // "unresolved", but uses every thread (incl. Resolved) to build the
      // retrieval plan — e.g. pointing at a resolved thread's far-earlier origin.
      supabase.from('story_threads').select('*').eq('book_id', bookId),
      supabase
        .from('chapter_outlines')
        .select('purpose, chapter_end_state, new_questions_created')
        .eq('chapter_id', chapterId)
        .eq('is_current', true)
        .maybeSingle(),
      supabase
        .from('writing_sections')
        .select('content')
        .eq('chapter_id', chapterId)
        .order('sort_order', { ascending: true })
        .limit(3)
    ]);

  if (!book) return fail('Book not found (or not yours).');

  const approvedVoiceExcerpts = (excerptRows ?? [])
    .map((r) => (r.content ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((t) => t.slice(0, 300));

  const input: AnalyzeInput = {
    book,
    currentChapter: {
      id: ctx.chapter.id,
      title: ctx.chapter.title,
      summary: ctx.chapter.summary,
      chapter_number: ctx.chapter.chapter_number
    },
    chapterIndex: (chapterIndex ?? []).map((c) => ({
      id: c.id,
      chapter_number: c.chapter_number,
      sort_order: c.sort_order
    })),
    previousChapterEnding: ctx.previousChapterEnding,
    sectionsSoFar: ctx.sectionsSoFarInThisChapter.map((s) => ({ content: s.content })),
    currentSectionContent: resolved.section.content ?? null,
    threads: (threads ?? []) as StoryThread[],
    relationships: ctx.relationships,
    characters: ctx.characters,
    settings: ctx.settings,
    canonFacts: ctx.canonFacts,
    timelineEvents: ctx.recentTimelineEvents,
    outlineNodePurpose: ctx.existingOutlineNode?.purpose ?? null,
    chapterOutline: chapterOutline
      ? {
          purpose: chapterOutline.purpose,
          chapter_end_state: chapterOutline.chapter_end_state,
          new_questions_created: chapterOutline.new_questions_created
        }
      : null,
    approvedVoiceExcerpts
  };

  const analysis = analyzeStoryState(input);

  // Module selection uses ONLY objective inputs: writer focus + presence flags.
  const active_modules: MethodologyModuleId[] = selectActiveModules({
    scope: 'section',
    focus,
    signals: analysis.presence
  });

  const structured = {
    ...analysis,
    focus,
    guidance: { active_modules, text: buildGuidanceText(active_modules) },
    provenance_legend: {
      canon: "canon_status='author_canon' or manuscript_status='confirmed_in_manuscript'",
      plan: 'outline / chapter_outline entries',
      working_note: "canon_status='working_note' (provisional)",
      ai_possibility: 'anything the host proposes in SUGGESTION MODE — provisional until the writer chooses it',
      note: 'candidate_items_for_attention are objective surfacings, not judgments. Literary priority is the host model’s call; the writer decides.'
    },
    meta: {
      llm_used: false,
      assembled_by: 'analyzeStoryState (deterministic)',
      relevance_gated: true,
      focus
    }
  };

  const headline =
    `Development briefing for "${ctx.chapter.title}" — ` +
    `${analysis.threads.length} thread(s), ${analysis.relationships.length} relationship(s), ` +
    `${analysis.candidate_items_for_attention.length} candidate item(s) for attention. ` +
    `Active methodology modules: ${active_modules.join(', ')}.`;

  return ok(headline, structured);
}

export type AnalyzeFocus = 'auto' | 'threads' | 'relationships' | 'arc' | 'dream' | 'chapter_goal' | 'story_health';

// Shared helpers for the write/version tools below.
const wc = (t: string) => { const s = t.trim(); return s ? s.split(/\s+/).length : 0; };
const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim();
function revisionResult(status: string, extra: Record<string, unknown>, summary?: string): ToolResult {
  const structured = { status, ...extra, meta: { llm_used: false } };
  return { content: [{ type: 'text', text: `${summary ?? status}\n\n${JSON.stringify(structured, null, 2)}` }], structuredContent: structured };
}

// --- Section version upload (preview = read; apply = write) -----------------
// A section upload is scoped to ONE existing section: the incoming text is the
// COMPLETE new content for that section — never split on "~~~", never mapped.
// Minimal, standard normalization (line endings, collapse 3+ blank lines, trim)
// matches how imported content is stored.
const normalizeContent = (s: string) =>
  s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const contentHash = (s: string) => { let h = 5381; const t = normalizeContent(s); for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); };

async function resolveSectionForVersion(supabase: SB, args: { book_id: string; section_id: string; chapter_id?: string }) {
  const { data: section } = await supabase
    .from('writing_sections')
    .select('id, chapter_id, content, word_count, updated_at')
    .eq('id', args.section_id)
    .maybeSingle();
  if (!section) return { status: 'NOT_FOUND' as const };
  if (args.chapter_id && args.chapter_id !== section.chapter_id) return { status: 'WRONG_RELATIONSHIP' as const };
  const { data: chapter } = await supabase.from('chapters').select('id, book_id').eq('id', section.chapter_id).maybeSingle();
  if (!chapter || chapter.book_id !== args.book_id) return { status: 'WRONG_RELATIONSHIP' as const };
  return { status: 'ok' as const, section };
}

export async function previewSectionVersion(
  supabase: SB,
  args: { book_id: string; section_id: string; chapter_id?: string; incoming_content: string }
): Promise<ToolResult> {
  const r = await resolveSectionForVersion(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Section not found or not permitted.' : 'Section does not belong to the given book/chapter.' });
  const current = r.section.content ?? '';
  const curNorm = normalizeContent(current);
  const incNorm = normalizeContent(args.incoming_content ?? '');
  const identical = curNorm === incNorm;

  const diff = identical ? [] : computeLineDiff(curNorm, incNorm);
  const added = diff.filter((d) => d.kind === 'added').length;
  const removed = diff.filter((d) => d.kind === 'removed').length;
  const unchangedLines = diff.filter((d) => d.kind === 'common').length;

  return revisionResult(
    identical ? 'UNCHANGED' : 'changed',
    {
      section_id: args.section_id,
      relationship: 'ok',
      current: { word_count: wc(current), content_hash: contentHash(current), updated_at: r.section.updated_at, excerpt: curNorm.slice(0, 140) },
      incoming: { word_count: wc(incNorm), content_hash: contentHash(incNorm), excerpt: incNorm.slice(0, 140) },
      word_count_before: wc(current),
      word_count_after: wc(incNorm),
      summary: { paragraphs_added: added, paragraphs_removed: removed, paragraphs_unchanged: unchangedLines },
      diff,
      note: 'Read-only preview. On apply, the current version is snapshotted to history before replacing the section.'
    },
    identical ? 'Incoming content is identical to the current section — nothing to apply.' : `Section will change: +${added} / -${removed} paragraph-lines.`
  );
}

export async function applySectionVersion(
  supabase: SB,
  args: { book_id: string; section_id: string; chapter_id?: string; expected_content_hash: string; expected_updated_at?: string; approved_content: string }
): Promise<ToolResult> {
  if (!(args.approved_content ?? '').trim()) return revisionResult('BAD_REQUEST', { detail: 'approved_content is empty.' });

  const r = await resolveSectionForVersion(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Section not found or not permitted.' : 'Section does not belong to the given book/chapter.' });
  const current = r.section.content ?? '';
  const curHash = contentHash(current);

  // Stale-preview protection: the section must still be what was previewed.
  if (args.expected_content_hash && args.expected_content_hash !== curHash) {
    return revisionResult('TARGET_CHANGED', { section_id: args.section_id, current_hash: curHash, detail: 'The section changed since it was previewed. Reload the current version before uploading a new one.' });
  }
  if (args.expected_updated_at && r.section.updated_at && args.expected_updated_at !== r.section.updated_at) {
    return revisionResult('TARGET_CHANGED', { section_id: args.section_id, current_updated_at: r.section.updated_at, detail: 'The section was modified since preview.' });
  }

  const incNorm = normalizeContent(args.approved_content);
  if (incNorm === normalizeContent(current)) return revisionResult('UNCHANGED', { section_id: args.section_id, detail: 'Incoming content matches current; no write performed.' });

  // Snapshot the pre-upload content FIRST (reuse section_versions).
  const { data: snap, error: snapErr } = await supabase
    .from('section_versions')
    .insert({ section_id: args.section_id, content: current, version_reason: 'manual_snapshot' })
    .select('id, created_at')
    .single();
  if (snapErr || !snap) return revisionResult('SNAPSHOT_FAILED', { detail: 'Could not snapshot the current version; the section was not changed.', error: snapErr?.message });

  const { data: updated, error: updErr } = await supabase
    .from('writing_sections')
    .update({ content: incNorm, word_count: wc(incNorm) })
    .eq('id', args.section_id)
    .select('updated_at, word_count')
    .single();
  if (updErr || !updated) return revisionResult('UPDATE_FAILED', { snapshot_version_id: snap.id, detail: 'Snapshot saved but the update failed; the section is unchanged and recoverable.', error: updErr?.message });

  return revisionResult(
    'applied',
    {
      section_id: args.section_id,
      snapshot_version_id: snap.id,
      snapshot_reason: 'manual_snapshot',
      previous_word_count: wc(current),
      word_count: updated.word_count,
      new_content_hash: contentHash(incNorm),
      updated_at: updated.updated_at
    },
    'New section version applied (previous version snapshotted).'
  );
}

// --- Section version history + restore --------------------------------------
// Read + restore over the SAME section_versions history that Upload writes to.
// No parallel system, no new table, no new version_reason. Restore is
// snapshot-first (identical safety to apply): the CURRENT content is snapshotted
// BEFORE the section is replaced with the chosen historical version — so a
// restore is itself reversible and the live section never changes without its
// prior state persisted. The version content comes from the server (by id),
// never from the client. version_id is always re-verified to belong to this
// section, so history/restore can never cross section boundaries.
const versionExcerpt = (s: string) => normalizeContent(s).slice(0, 160);

export async function listSectionVersions(
  supabase: SB,
  args: { book_id: string; section_id: string; chapter_id?: string }
): Promise<ToolResult> {
  const r = await resolveSectionForVersion(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Section not found or not permitted.' : 'Section does not belong to the given book/chapter.' });
  const current = r.section.content ?? '';
  const { data: rows, error } = await supabase
    .from('section_versions')
    .select('id, version_reason, created_at, content')
    .eq('section_id', args.section_id)
    .order('created_at', { ascending: false });
  if (error) return revisionResult('LIST_FAILED', { detail: 'Could not load version history.', error: error.message });
  const versions = (rows ?? []).map((v) => ({
    id: v.id,
    version_reason: v.version_reason,
    created_at: v.created_at,
    word_count: wc(v.content ?? ''),
    excerpt: versionExcerpt(v.content ?? '')
  }));
  return revisionResult(
    'ok',
    {
      section_id: args.section_id,
      current: { word_count: wc(current), content_hash: contentHash(current), updated_at: r.section.updated_at, excerpt: versionExcerpt(current) },
      count: versions.length,
      versions
    },
    `${versions.length} saved version(s) for this section.`
  );
}

export async function previewSectionRestore(
  supabase: SB,
  args: { book_id: string; section_id: string; chapter_id?: string; version_id: string }
): Promise<ToolResult> {
  const r = await resolveSectionForVersion(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Section not found or not permitted.' : 'Section does not belong to the given book/chapter.' });
  const { data: version } = await supabase
    .from('section_versions')
    .select('id, section_id, content, version_reason, created_at')
    .eq('id', args.version_id)
    .maybeSingle();
  if (!version || version.section_id !== args.section_id) return revisionResult('VERSION_NOT_FOUND', { detail: 'That version was not found for this section.' });

  const current = r.section.content ?? '';
  const curNorm = normalizeContent(current);
  const selNorm = normalizeContent(version.content ?? '');
  const identical = curNorm === selNorm;

  // Orientation: current = "before" (left), the selected version = "after"
  // (what the section becomes if restored). Reuses computeLineDiff exactly.
  const diff = identical ? [] : computeLineDiff(curNorm, selNorm);
  const added = diff.filter((d) => d.kind === 'added').length;
  const removed = diff.filter((d) => d.kind === 'removed').length;
  const unchangedLines = diff.filter((d) => d.kind === 'common').length;

  return revisionResult(
    identical ? 'UNCHANGED' : 'changed',
    {
      section_id: args.section_id,
      version_id: version.id,
      selected: { version_reason: version.version_reason, created_at: version.created_at, word_count: wc(version.content ?? '') },
      current: { word_count: wc(current), content_hash: contentHash(current), updated_at: r.section.updated_at },
      word_count_before: wc(current),
      word_count_after: wc(selNorm),
      summary: { paragraphs_added: added, paragraphs_removed: removed, paragraphs_unchanged: unchangedLines },
      diff,
      note: 'Read-only. On restore, the current section is snapshotted to history before it is replaced with this version.'
    },
    identical ? 'This version is identical to the current section — nothing to restore.' : `Restoring this version changes the section: +${added} / -${removed} paragraph-lines.`
  );
}

export async function applySectionRestore(
  supabase: SB,
  args: { book_id: string; section_id: string; chapter_id?: string; version_id: string; expected_content_hash: string; expected_updated_at?: string }
): Promise<ToolResult> {
  const r = await resolveSectionForVersion(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Section not found or not permitted.' : 'Section does not belong to the given book/chapter.' });
  const current = r.section.content ?? '';
  const curHash = contentHash(current);

  // Same stale/current-content protection as Upload — one concurrency model.
  if (args.expected_content_hash && args.expected_content_hash !== curHash) {
    return revisionResult('TARGET_CHANGED', { section_id: args.section_id, current_hash: curHash, detail: 'The section changed since the comparison was opened. Refresh before restoring.' });
  }
  if (args.expected_updated_at && r.section.updated_at && args.expected_updated_at !== r.section.updated_at) {
    return revisionResult('TARGET_CHANGED', { section_id: args.section_id, current_updated_at: r.section.updated_at, detail: 'The section was modified since the comparison was opened.' });
  }

  const { data: version } = await supabase
    .from('section_versions')
    .select('id, section_id, content')
    .eq('id', args.version_id)
    .maybeSingle();
  if (!version || version.section_id !== args.section_id) return revisionResult('VERSION_NOT_FOUND', { detail: 'That version was not found for this section.' });

  const restoreNorm = normalizeContent(version.content ?? '');
  if (!restoreNorm.trim()) return revisionResult('BAD_REQUEST', { detail: 'That version has no content to restore.' });
  if (restoreNorm === normalizeContent(current)) return revisionResult('UNCHANGED', { section_id: args.section_id, detail: 'Selected version matches current; no write performed.' });

  // Snapshot the CURRENT content FIRST (reuse section_versions/manual_snapshot),
  // so restoring is reversible through this same history.
  const { data: snap, error: snapErr } = await supabase
    .from('section_versions')
    .insert({ section_id: args.section_id, content: current, version_reason: 'manual_snapshot' })
    .select('id, created_at')
    .single();
  if (snapErr || !snap) return revisionResult('SNAPSHOT_FAILED', { detail: 'Could not snapshot the current version; the section was not changed.', error: snapErr?.message });

  const { data: updated, error: updErr } = await supabase
    .from('writing_sections')
    .update({ content: restoreNorm, word_count: wc(restoreNorm) })
    .eq('id', args.section_id)
    .select('updated_at, word_count')
    .single();
  if (updErr || !updated) return revisionResult('UPDATE_FAILED', { snapshot_version_id: snap.id, detail: 'Snapshot saved but the update failed; the section is unchanged and recoverable.', error: updErr?.message });

  return revisionResult(
    'applied',
    {
      section_id: args.section_id,
      restored_from_version_id: version.id,
      snapshot_version_id: snap.id,
      snapshot_reason: 'manual_snapshot',
      previous_word_count: wc(current),
      word_count: updated.word_count,
      new_content_hash: contentHash(restoreNorm),
      updated_at: updated.updated_at
    },
    'Section restored (previous version snapshotted).'
  );
}

// --- Chapter version upload (structured, section-aware) ---------------------
// A CHAPTER upload is NOT one big section. The incoming document is parsed into
// structured sections FIRST (reusing the tuned "~~~" scene-break rule — never
// character splitting), then each proposed section is matched to an existing
// section by content identity (exact, else best line-overlap), never by array
// position alone. The parser/matcher produce a clean plan; nothing downstream
// (diff, modal, apply) re-infers section boundaries. Apply is one transaction
// (apply_chapter_version RPC): snapshot the whole chapter, then apply approved
// changes atomically — a chapter can never end up half old / half new. Sections
// present in the chapter but absent from the upload are PRESERVED by default;
// they are removed only when the writer explicitly opts in.
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

// Same split as the tuned importer (scripts/import-chapters.mts): lines of
// tildes separate sections; no separator → one section. Each block is stored
// with the standard section normalization so UNCHANGED detection is exact.
const splitChapterSections = (raw: string): string[] =>
  raw.split(/\n?~+(?:\s*~+)*\n/).map((s) => normalizeContent(s)).filter(Boolean);

const deriveSectionTitle = (content: string): string => {
  const first = content.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
};

// Deterministic concurrency token — MUST equal the SQL chapter_state_hash():
// md5 over the ordered sections' id + sort_order + md5(RAW stored content).
type CurSection = { id: string; sort_order: number; title: string | null; content: string; word_count: number };
const orderSections = (secs: CurSection[]) =>
  [...secs].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
function chapterStateHashTS(secs: CurSection[]): string {
  const agg = orderSections(secs).map((s) => `${s.id}:${s.sort_order}:${md5(s.content)}`).join('|');
  return md5(agg);
}

// Word-level Jaccard — cheap, order-insensitive similarity used ONLY to pair an
// edited incoming block with its existing section after exact matches are
// exhausted. Word-level (not line-level) so in-paragraph wording edits, which
// change whole lines, still register as the SAME section rather than an
// add+delete. Distinct sections share only function words → score stays low.
function wordJaccard(a: string, b: string): number {
  const setOf = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
  const A = setOf(a), B = setOf(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}
const MATCH_THRESHOLD = 0.3;

type ChapterEntry =
  | { role: 'unchanged' | 'modified'; proposed_index: number; section_id: string; title: string | null; current_content: string; current_word_count: number; content: string; incoming_word_count: number }
  | { role: 'added'; proposed_index: number; title: string; content: string; incoming_word_count: number };
type ChapterPlan = { entries: ChapterEntry[]; missing: CurSection[]; currentSorted: CurSection[] };

// Pure parse + match. Used identically by preview and apply so classification
// lives in ONE place and never in the UI. `current` is the live chapter.
function computeChapterPlan(current: CurSection[], incoming: string): ChapterPlan {
  const currentSorted = orderSections(current);
  const proposed = splitChapterSections(incoming);
  const norm = currentSorted.map((c) => ({ c, n: normalizeContent(c.content) }));
  const used = new Set<string>();
  const matchOf = new Map<number, string>();
  const roleOf = new Map<number, 'unchanged' | 'modified'>();

  // 1) exact content identity → UNCHANGED
  proposed.forEach((np, pi) => {
    const hit = norm.find((x) => !used.has(x.c.id) && x.n === np);
    if (hit) { used.add(hit.c.id); matchOf.set(pi, hit.c.id); roleOf.set(pi, 'unchanged'); }
  });

  // 2) best line-overlap on the remainder → MODIFIED (greedy, thresholded)
  const remP = proposed.map((np, pi) => ({ np, pi })).filter((x) => !matchOf.has(x.pi));
  const remC = norm.filter((x) => !used.has(x.c.id));
  const pairs: { pi: number; cid: string; score: number }[] = [];
  for (const p of remP) for (const c of remC) pairs.push({ pi: p.pi, cid: c.c.id, score: wordJaccard(p.np, c.n) });
  pairs.sort((a, b) => b.score - a.score);
  for (const pr of pairs) {
    if (pr.score < MATCH_THRESHOLD) break;
    if (matchOf.has(pr.pi) || used.has(pr.cid)) continue;
    matchOf.set(pr.pi, pr.cid); roleOf.set(pr.pi, 'modified'); used.add(pr.cid);
  }

  const entries: ChapterEntry[] = proposed.map((np, pi) => {
    const cid = matchOf.get(pi);
    if (!cid) return { role: 'added', proposed_index: pi, title: deriveSectionTitle(np), content: np, incoming_word_count: wc(np) };
    const c = currentSorted.find((x) => x.id === cid)!;
    return { role: roleOf.get(pi)!, proposed_index: pi, section_id: cid, title: c.title, current_content: c.content, current_word_count: wc(c.content), content: np, incoming_word_count: wc(np) };
  });
  const missing = currentSorted.filter((c) => !used.has(c.id));
  return { entries, missing, currentSorted };
}

// Final section order for a plan, given which missing sections are removed.
// Proposed (matched + added) keep the uploaded document's order; preserved-
// missing sections are re-inserted right after their original predecessor so
// they DON'T appear reordered merely because the upload omitted them.
type OrderItem = { kind: 'existing' | 'new'; section_id?: string; entry?: ChapterEntry; missing?: boolean };
function buildChapterOrder(plan: ChapterPlan, removalSet: Set<string>): OrderItem[] {
  const items: OrderItem[] = plan.entries.map((e) =>
    'section_id' in e ? { kind: 'existing', section_id: e.section_id, entry: e } : { kind: 'new', entry: e }
  );
  const retainedMissing = plan.missing.filter((m) => !removalSet.has(m.id));
  for (const m of retainedMissing) {
    const originalIndex = plan.currentSorted.findIndex((c) => c.id === m.id);
    let insertPos = 0;
    for (let k = originalIndex - 1; k >= 0; k--) {
      const prevId = plan.currentSorted[k]!.id;
      const at = items.findIndex((it) => it.kind === 'existing' && it.section_id === prevId);
      if (at >= 0) { insertPos = at + 1; break; }
    }
    items.splice(insertPos, 0, { kind: 'existing', section_id: m.id, missing: true });
  }
  return items;
}

const diffSummary = (diff: ReturnType<typeof computeLineDiff>) => ({
  paragraphs_added: diff.filter((d) => d.kind === 'added').length,
  paragraphs_removed: diff.filter((d) => d.kind === 'removed').length,
  paragraphs_unchanged: diff.filter((d) => d.kind === 'common').length
});

async function resolveChapter(supabase: SB, args: { book_id: string; chapter_id: string }) {
  const { data: chapter } = await supabase.from('chapters').select('id, book_id, title, chapter_number').eq('id', args.chapter_id).maybeSingle();
  if (!chapter) return { status: 'NOT_FOUND' as const };
  if (chapter.book_id !== args.book_id) return { status: 'WRONG_RELATIONSHIP' as const };
  const { data: secs } = await supabase.from('writing_sections').select('id, sort_order, title, content, word_count').eq('chapter_id', args.chapter_id);
  return { status: 'ok' as const, chapter, sections: (secs ?? []) as CurSection[] };
}

export async function previewChapterVersion(
  supabase: SB,
  args: { book_id: string; chapter_id: string; incoming_content: string }
): Promise<ToolResult> {
  if (!(args.incoming_content ?? '').trim()) return revisionResult('BAD_REQUEST', { detail: 'The uploaded chapter is empty.' });
  const r = await resolveChapter(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Chapter not found or not permitted.' : 'Chapter does not belong to the given book.' });

  const plan = computeChapterPlan(r.sections, args.incoming_content);
  const chapterHash = chapterStateHashTS(r.sections);

  // Ordered display list: proposed sections in document order, then preserved-missing.
  const sections = plan.entries.map((e) => {
    if (e.role === 'added') {
      const diff = computeLineDiff('', e.content);
      return { role: 'added' as const, title: e.title, incoming_word_count: e.incoming_word_count, diff, summary: diffSummary(diff) };
    }
    const diff = e.role === 'modified' ? computeLineDiff(normalizeContent(e.current_content), e.content) : [];
    return {
      role: e.role, section_id: e.section_id, title: e.title,
      current_word_count: e.current_word_count, incoming_word_count: e.incoming_word_count,
      diff, summary: diffSummary(diff)
    };
  });
  const missing = plan.missing.map((m) => ({ role: 'missing' as const, section_id: m.id, title: m.title, current_word_count: wc(m.content) }));

  // Proposed order of EXISTING sections vs their current order → reordered?
  const currentExistingOrder = plan.currentSorted.map((c) => c.id);
  const proposedExistingOrder = buildChapterOrder(plan, new Set())
    .filter((it) => it.kind === 'existing' && it.section_id)
    .map((it) => it.section_id!);
  const reordered =
    currentExistingOrder.length === proposedExistingOrder.length &&
    currentExistingOrder.some((id, i) => proposedExistingOrder[i] !== id);

  const counts = {
    modified: plan.entries.filter((e) => e.role === 'modified').length,
    unchanged: plan.entries.filter((e) => e.role === 'unchanged').length,
    added: plan.entries.filter((e) => e.role === 'added').length,
    missing: plan.missing.length
  };
  const noChange = counts.modified === 0 && counts.added === 0 && counts.missing === 0 && !reordered;

  return revisionResult(
    noChange ? 'UNCHANGED' : 'changed',
    {
      chapter: { id: r.chapter.id, title: r.chapter.title, chapter_number: r.chapter.chapter_number },
      chapter_hash: chapterHash,
      summary: counts,
      reordered,
      order: { current: currentExistingOrder, proposed: proposedExistingOrder },
      sections: [...sections, ...missing],
      note: 'Read-only. On apply, the whole current chapter is snapshotted to history, then approved changes are applied in one transaction. Missing sections are preserved unless you choose to remove them.'
    },
    noChange
      ? 'Uploaded chapter matches the current chapter — nothing to apply.'
      : `Chapter changes: ${counts.modified} modified · ${counts.unchanged} unchanged · ${counts.added} new · ${counts.missing} not in upload${reordered ? ' · order changed' : ''}.`
  );
}

export async function applyChapterVersion(
  supabase: SB,
  args: { book_id: string; chapter_id: string; incoming_content: string; expected_chapter_hash: string; removals?: string[] }
): Promise<ToolResult> {
  if (!(args.incoming_content ?? '').trim()) return revisionResult('BAD_REQUEST', { detail: 'The uploaded chapter is empty.' });
  const r = await resolveChapter(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Chapter not found or not permitted.' : 'Chapter does not belong to the given book.' });

  const liveHash = chapterStateHashTS(r.sections);
  if (args.expected_chapter_hash && args.expected_chapter_hash !== liveHash) {
    return revisionResult('TARGET_CHANGED', { chapter_id: args.chapter_id, current_hash: liveHash, detail: 'The chapter changed since it was previewed. Refresh the comparison before applying.' });
  }

  const plan = computeChapterPlan(r.sections, args.incoming_content);
  const removalSet = new Set((args.removals ?? []).filter((id) => plan.missing.some((m) => m.id === id)));

  // Deterministic final order (shared with preview): proposed order, preserved-
  // missing re-inserted after their original predecessor. Index = new sort_order.
  const ordered = buildChapterOrder(plan, removalSet);
  const currentSortById = new Map(plan.currentSorted.map((c) => [c.id, c.sort_order] as const));

  type ExistingEntry = Extract<ChapterEntry, { role: 'unchanged' | 'modified' }>;
  const updates = (plan.entries.filter((e) => e.role === 'modified') as ExistingEntry[])
    .map((e) => ({ section_id: e.section_id, content: e.content, word_count: e.incoming_word_count }));
  const inserts = ordered
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.kind === 'new')
    .map(({ f, i }) => { const e = f.entry as Extract<ChapterEntry, { role: 'added' }>; return { title: e.title, content: e.content, word_count: e.incoming_word_count, sort_order: i }; });
  const order = ordered
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => f.kind === 'existing' && f.section_id != null && currentSortById.get(f.section_id) !== i)
    .map(({ f, i }) => ({ section_id: f.section_id!, sort_order: i }));
  const removals = [...removalSet];

  // Identical upload (or all choices net to nothing) → no write, no snapshot.
  if (updates.length === 0 && inserts.length === 0 && order.length === 0 && removals.length === 0) {
    return revisionResult('UNCHANGED', { chapter_id: args.chapter_id, detail: 'Uploaded chapter matches the current chapter; no write performed.' });
  }

  const { data, error } = await supabase.rpc('apply_chapter_version', {
    p_book_id: args.book_id,
    p_chapter_id: args.chapter_id,
    p_expected_hash: liveHash,
    p_updates: updates,
    p_inserts: inserts,
    p_order: order,
    p_removals: removals,
    p_version_reason: 'before_chapter_upload'
  });

  if (error) {
    const m = error.message || '';
    const status = /TARGET_CHANGED/.test(m) ? 'TARGET_CHANGED' : /NOT_FOUND/.test(m) ? 'NOT_FOUND' : /WRONG_RELATIONSHIP/.test(m) ? 'WRONG_RELATIONSHIP' : 'APPLY_FAILED';
    return revisionResult(status, { chapter_id: args.chapter_id, detail: 'The chapter was not changed.', error: m });
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return revisionResult(
    'applied',
    {
      chapter_id: args.chapter_id,
      chapter_version_id: res.chapter_version_id,
      applied_updates: res.applied_updates,
      inserted: res.inserted,
      removed: res.removed,
      reordered: res.reordered,
      chapter_hash: res.chapter_hash
    },
    'Chapter version applied (previous chapter snapshotted).'
  );
}

// --- Chapter version history + restore --------------------------------------
// Read + restore over the SAME chapter_versions snapshots that Chapter Upload
// writes. No parallel system. Restore is snapshot-first and transactional
// (apply_chapter_restore RPC): the current chapter is snapshotted, then the live
// sections are reconciled to EXACTLY the selected snapshot — so a restore is
// itself reversible. Comparison is by stored section_id (identity), never by
// flattening the chapter into one text blob.

export async function listChapterVersions(
  supabase: SB,
  args: { book_id: string; chapter_id: string }
): Promise<ToolResult> {
  const r = await resolveChapter(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Chapter not found or not permitted.' : 'Chapter does not belong to the given book.' });
  const currentWc = r.sections.reduce((n, s) => n + wc(s.content), 0);
  const { data: rows, error } = await supabase
    .from('chapter_versions')
    .select('id, version_reason, chapter_title, chapter_hash, created_at, snapshot')
    .eq('chapter_id', args.chapter_id)
    .order('created_at', { ascending: false });
  if (error) return revisionResult('LIST_FAILED', { detail: 'Could not load chapter version history.', error: error.message });
  const versions = (rows ?? []).map((v) => {
    const secs = ((v.snapshot as ChapterSnapshot | null)?.sections) ?? [];
    return {
      version_id: v.id,
      created_at: v.created_at,
      version_reason: v.version_reason,
      chapter_title: v.chapter_title,
      chapter_hash: v.chapter_hash,
      section_count: secs.length,
      word_count: secs.reduce((n, s) => n + (typeof s.word_count === 'number' ? s.word_count : wc(s.content ?? '')), 0)
    };
  });
  return revisionResult(
    'ok',
    {
      chapter: { id: r.chapter.id, title: r.chapter.title, chapter_number: r.chapter.chapter_number },
      current: { word_count: currentWc, section_count: r.sections.length, content_hash: chapterStateHashTS(r.sections) },
      count: versions.length,
      versions
    },
    `${versions.length} saved chapter version(s).`
  );
}

export async function previewChapterRestore(
  supabase: SB,
  args: { book_id: string; chapter_id: string; version_id: string }
): Promise<ToolResult> {
  const r = await resolveChapter(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Chapter not found or not permitted.' : 'Chapter does not belong to the given book.' });
  const { data: row } = await supabase
    .from('chapter_versions')
    .select('id, chapter_id, version_reason, chapter_title, created_at, snapshot')
    .eq('id', args.version_id)
    .maybeSingle();
  if (!row || row.chapter_id !== args.chapter_id) return revisionResult('VERSION_NOT_FOUND', { detail: 'That chapter version was not found for this chapter.' });

  const snap = row.snapshot as ChapterSnapshot;
  const snapSecs = [...(snap.sections ?? [])].sort((a, b) => a.sort_order - b.sort_order || (a.section_id < b.section_id ? -1 : 1));
  const curSecs = orderSections(r.sections);
  const curById = new Map(curSecs.map((s) => [s.id, s]));
  const snapById = new Map(snapSecs.map((s) => [s.section_id, s]));

  const sections: Record<string, unknown>[] = [];
  let modified = 0, unchanged = 0, onlyInSelected = 0, onlyInCurrent = 0, renamedCount = 0;

  // Selected-snapshot order first — reads as "what the restored chapter becomes".
  for (const sn of snapSecs) {
    const cur = curById.get(sn.section_id);
    const selWc = typeof sn.word_count === 'number' ? sn.word_count : wc(sn.content ?? '');
    if (!cur) {
      const diff = computeLineDiff('', sn.content ?? '');
      sections.push({ role: 'only_in_selected', section_id: sn.section_id, title: sn.title, selected_word_count: selWc, diff, summary: diffSummary(diff) });
      onlyInSelected++;
      continue;
    }
    const renamed = (cur.title ?? '') !== (sn.title ?? '');
    const same = normalizeContent(cur.content ?? '') === normalizeContent(sn.content ?? '');
    if (same && !renamed) {
      sections.push({ role: 'unchanged', section_id: sn.section_id, title: cur.title ?? sn.title, current_word_count: wc(cur.content ?? ''), selected_word_count: selWc });
      unchanged++;
      continue;
    }
    const diff = same ? [] : computeLineDiff(normalizeContent(cur.content ?? ''), normalizeContent(sn.content ?? ''));
    if (renamed) renamedCount++;
    sections.push({ role: 'modified', section_id: sn.section_id, title: sn.title, current_title: cur.title, selected_title: sn.title, renamed, current_word_count: wc(cur.content ?? ''), selected_word_count: selWc, diff, summary: diffSummary(diff) });
    modified++;
  }
  // Sections that exist now but not in the snapshot — restore would remove them.
  for (const cur of curSecs) {
    if (!snapById.has(cur.id)) {
      sections.push({ role: 'only_in_current', section_id: cur.id, title: cur.title, current_word_count: wc(cur.content ?? '') });
      onlyInCurrent++;
    }
  }
  // Reorder among sections common to both.
  const commonCurrentOrder = curSecs.filter((s) => snapById.has(s.id)).map((s) => s.id);
  const commonSnapOrder = snapSecs.filter((s) => curById.has(s.section_id)).map((s) => s.section_id);
  const reordered = commonCurrentOrder.length === commonSnapOrder.length && commonCurrentOrder.some((id, i) => commonSnapOrder[i] !== id);

  const noChange = modified === 0 && onlyInSelected === 0 && onlyInCurrent === 0 && renamedCount === 0 && !reordered;
  const selWordCount = snapSecs.reduce((n, s) => n + (typeof s.word_count === 'number' ? s.word_count : wc(s.content ?? '')), 0);

  return revisionResult(
    noChange ? 'UNCHANGED' : 'changed',
    {
      chapter: { id: r.chapter.id, title: r.chapter.title, chapter_number: r.chapter.chapter_number },
      chapter_hash: chapterStateHashTS(r.sections),
      selected: { version_id: row.id, created_at: row.created_at, version_reason: row.version_reason, chapter_title: row.chapter_title, word_count: selWordCount, section_count: snapSecs.length },
      current: { word_count: r.sections.reduce((n, s) => n + wc(s.content), 0), section_count: r.sections.length },
      summary: { unchanged, modified, only_in_current: onlyInCurrent, only_in_selected: onlyInSelected, renamed: renamedCount },
      reordered,
      sections,
      note: 'Read-only. On restore, the whole current chapter is snapshotted to history, then the chapter is reconciled to this version in one transaction.'
    },
    noChange
      ? 'This version matches the current chapter — nothing to restore.'
      : `Restoring changes: ${modified} modified · ${onlyInSelected} only in this version · ${onlyInCurrent} only in current${reordered ? ' · order changed' : ''}.`
  );
}

export async function applyChapterRestore(
  supabase: SB,
  args: { book_id: string; chapter_id: string; version_id: string; expected_chapter_hash: string }
): Promise<ToolResult> {
  const r = await resolveChapter(supabase, args);
  if (r.status !== 'ok') return revisionResult(r.status, { detail: r.status === 'NOT_FOUND' ? 'Chapter not found or not permitted.' : 'Chapter does not belong to the given book.' });
  const liveHash = chapterStateHashTS(r.sections);
  if (args.expected_chapter_hash && args.expected_chapter_hash !== liveHash) {
    return revisionResult('TARGET_CHANGED', { chapter_id: args.chapter_id, current_hash: liveHash, detail: 'The chapter changed since the comparison was opened. Refresh before restoring.' });
  }

  const { data, error } = await supabase.rpc('apply_chapter_restore', {
    p_book_id: args.book_id,
    p_chapter_id: args.chapter_id,
    p_expected_hash: liveHash,
    p_version_id: args.version_id
  });
  if (error) {
    const m = error.message || '';
    const status = /TARGET_CHANGED/.test(m) ? 'TARGET_CHANGED' : /VERSION_NOT_FOUND/.test(m) ? 'VERSION_NOT_FOUND' : /NOT_FOUND/.test(m) ? 'NOT_FOUND' : /WRONG_RELATIONSHIP/.test(m) ? 'WRONG_RELATIONSHIP' : 'RESTORE_FAILED';
    return revisionResult(status, { chapter_id: args.chapter_id, detail: 'The chapter was not changed.', error: m });
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return revisionResult(
    'applied',
    {
      chapter_id: args.chapter_id,
      restore_snapshot_id: res.restore_snapshot_id,
      restored_from_version_id: res.restored_from_version_id,
      updated: res.updated,
      inserted: res.inserted,
      deleted: res.deleted
    },
    'Chapter restored (previous chapter snapshotted).'
  );
}

// --- Full-book / manuscript version upload ----------------------------------
// Orchestrates the existing chapter/section machinery over a WHOLE manuscript.
// Parser is reused (parseManuscript = the tuned import rules). Section matching
// inside a mapped chapter reuses computeChapterPlan/buildChapterOrder — no second
// matcher. KEEP-only: a chapter absent from the upload is preserved (never
// deleted); only SECTIONS are removable, and only when explicitly approved.
type CurChap = { id: string; chapter_number: number | null; title: string; sort_order: number };

async function resolveBook(supabase: SB, book_id: string) {
  const { data: book } = await supabase.from('books').select('id, title').eq('id', book_id).maybeSingle();
  if (!book) return { status: 'NOT_FOUND' as const };
  return { status: 'ok' as const, book };
}

async function fetchManuscript(supabase: SB, book_id: string) {
  // fetchManuscript is the CURRENT (active) manuscript — excludes inactive chapters.
  const { data: chapters } = await supabase.from('chapters').select('id, chapter_number, title, sort_order').eq('book_id', book_id).is('archived_at', null);
  const chList = (chapters ?? []) as CurChap[];
  const byChapter = new Map<string, CurSection[]>();
  if (chList.length) {
    const { data: secs } = await supabase.from('writing_sections').select('id, chapter_id, sort_order, title, content, word_count').in('chapter_id', chList.map((c) => c.id));
    for (const s of (secs ?? []) as (CurSection & { chapter_id: string })[]) {
      const arr = byChapter.get(s.chapter_id) ?? [];
      arr.push(s); byChapter.set(s.chapter_id, arr);
    }
  }
  return { chapters: [...chList].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)), byChapter };
}

function manuscriptStateHashTS(chapters: CurChap[], byChapter: Map<string, CurSection[]>): string {
  const chSorted = [...chapters].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
  const parts = chSorted.map((c) => {
    const secs = orderSections(byChapter.get(c.id) ?? []);
    const secStr = secs.map((s) => `${s.id}:${s.sort_order}:${s.title ?? ''}:${md5(s.content)}`).join('|');
    return `${c.id}:${c.sort_order}:${c.chapter_number ?? ''}:${c.title ?? ''}#${secStr}`;
  });
  return md5(parts.join('||'));
}

const chapterFullText = (secs: { content: string }[]) => secs.map((s) => s.content).join('\n\n');
// Body for the section matcher: MUST rejoin with "~~~" so computeChapterPlan
// re-splits into the same sections (chapterFullText's plain join is only for
// similarity scoring).
const chapterBody = (secs: { content: string }[]) => secs.map((s) => s.content).join('\n\n~~~\n\n');
const CH_TITLE_MATCH = 0.5;   // content-similarity to auto-map
const CH_REVIEW_MATCH = 0.25; // content-similarity to suggest (needs review)

type ChapterMatch =
  | { incoming_index: number; role: 'unchanged' | 'modified'; current_chapter_id: string }
  | { incoming_index: number; role: 'new' }
  | { incoming_index: number; role: 'needs_review'; suggested_chapter_id?: string; candidates: { chapter_id: string; title: string; score: number }[] };

// Match incoming parsed chapters to current chapters by identity signals
// (exact title, then content similarity), never array position alone.
function matchChapters(current: CurChap[], byChapter: Map<string, CurSection[]>, incoming: ReturnType<typeof parseManuscript>['chapters']) {
  const used = new Set<string>();
  const matches: ChapterMatch[] = [];
  const curNormTitle = new Map(current.map((c) => [c.id, normalizeContent(c.title ?? '').toLowerCase()]));
  const curText = new Map(current.map((c) => [c.id, chapterFullText(byChapter.get(c.id) ?? [])]));

  // Pass 1: exact normalized-title match
  const pending: number[] = [];
  incoming.forEach((inc, i) => {
    const t = normalizeContent(inc.title ?? '').toLowerCase();
    const hit = current.find((c) => !used.has(c.id) && curNormTitle.get(c.id) === t && t.length > 0);
    if (hit) { used.add(hit.id); matches[i] = { incoming_index: i, role: 'modified', current_chapter_id: hit.id }; }
    else pending.push(i);
  });
  // Pass 2: content similarity on the remainder
  for (const i of pending) {
    const incText = chapterFullText(incoming[i]!.sections);
    const scored = current.filter((c) => !used.has(c.id))
      .map((c) => ({ chapter_id: c.id, title: c.title, score: wordJaccard(incText, curText.get(c.id) ?? '') }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best && best.score >= CH_TITLE_MATCH) { used.add(best.chapter_id); matches[i] = { incoming_index: i, role: 'modified', current_chapter_id: best.chapter_id }; }
    else if (best && best.score >= CH_REVIEW_MATCH) matches[i] = { incoming_index: i, role: 'needs_review', suggested_chapter_id: best.chapter_id, candidates: scored.slice(0, 3) };
    else matches[i] = { incoming_index: i, role: 'new' };
  }
  const missing = current.filter((c) => !used.has(c.id));
  return { matches, missing };
}

// Section-level ops for ONE mapped chapter (reuses the chapter-upload matcher).
function chapterOpsFor(currentSections: CurSection[], incomingText: string, removalSet: Set<string>) {
  const plan = computeChapterPlan(currentSections, incomingText);
  const ordered = buildChapterOrder(plan, removalSet);
  const currentSortById = new Map(plan.currentSorted.map((c) => [c.id, c.sort_order] as const));
  type ExistingEntry = Extract<ChapterEntry, { role: 'unchanged' | 'modified' }>;
  const updates = (plan.entries.filter((e) => e.role === 'modified') as ExistingEntry[]).map((e) => ({ section_id: e.section_id, content: e.content, word_count: e.incoming_word_count }));
  const inserts = ordered.map((f, i) => ({ f, i })).filter(({ f }) => f.kind === 'new').map(({ f, i }) => { const e = f.entry as Extract<ChapterEntry, { role: 'added' }>; return { title: e.title, content: e.content, word_count: e.incoming_word_count, sort_order: i }; });
  const reorder = ordered.map((f, i) => ({ f, i })).filter(({ f, i }) => f.kind === 'existing' && f.section_id != null && currentSortById.get(f.section_id) !== i).map(({ f, i }) => ({ section_id: f.section_id!, sort_order: i }));
  const removals = [...removalSet].filter((id) => plan.missing.some((m) => m.id === id));
  return { plan, updates, inserts, reorder, removals };
}

export async function previewManuscriptVersion(
  supabase: SB,
  args: { book_id: string; incoming_content: string }
): Promise<ToolResult> {
  if (!(args.incoming_content ?? '').trim()) return revisionResult('BAD_REQUEST', { detail: 'The uploaded manuscript is empty.' });
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });

  const parsed = parseManuscript(args.incoming_content);
  if (parsed.chapters.length === 0) return revisionResult('NO_CHAPTERS', { detail: 'No chapters were detected. Chapters must start with a line like "Chapter 1: Title".' });

  const { chapters: current, byChapter } = await fetchManuscript(supabase, args.book_id);
  const manuscriptHash = manuscriptStateHashTS(current, byChapter);
  const { matches, missing } = matchChapters(current, byChapter, parsed.chapters);
  const currentById = new Map(current.map((c) => [c.id, c]));

  let unchanged = 0, modified = 0, added = 0, needsReview = 0;
  const chapterCards = parsed.chapters.map((inc, i) => {
    const m = matches[i]!;
    const incText = chapterFullText(inc.sections);
    const incWords = inc.sections.reduce((n, s) => n + s.word_count, 0);
    if (m.role === 'new') { added++; return { incoming_index: i, role: 'new' as const, title: inc.title, chapter_number: inc.chapter_number, incoming_word_count: incWords, incoming_section_count: inc.sections.length }; }
    if (m.role === 'needs_review') {
      needsReview++;
      return { incoming_index: i, role: 'needs_review' as const, title: inc.title, chapter_number: inc.chapter_number, incoming_word_count: incWords, suggested_chapter_id: m.suggested_chapter_id, candidates: m.candidates };
    }
    // mapped
    const cur = currentById.get(m.current_chapter_id)!;
    const curSecs = byChapter.get(cur.id) ?? [];
    const { plan } = chapterOpsFor(curSecs, chapterBody(inc.sections), new Set());
    const secModified = plan.entries.filter((e) => e.role === 'modified').length;
    const secAdded = plan.entries.filter((e) => e.role === 'added').length;
    const secMissing = plan.missing.length;
    const renamed = normalizeContent(cur.title ?? '') !== normalizeContent(inc.title ?? '');
    const isChanged = secModified > 0 || secAdded > 0 || secMissing > 0 || renamed;
    if (isChanged) modified++; else unchanged++;
    return {
      incoming_index: i, role: (isChanged ? 'modified' : 'unchanged') as 'modified' | 'unchanged', title: inc.title, chapter_number: inc.chapter_number,
      current_chapter_id: cur.id, current_title: cur.title, renamed,
      current_word_count: (curSecs).reduce((n, s) => n + wc(s.content), 0), incoming_word_count: incWords,
      section_summary: { modified: secModified, added: secAdded, missing: secMissing, unchanged: plan.entries.filter((e) => e.role === 'unchanged').length },
      // for the drill-down: sections the upload omitted (offer removal), and the
      // incoming body so the UI can reuse /api/chapters/preview-version for diffs.
      missing_sections: plan.missing.map((m) => ({ section_id: m.id, title: m.title, word_count: wc(m.content) })),
      incoming_body: chapterBody(inc.sections)
    };
  });

  // chapter reorder among confidently-mapped chapters
  const mappedCurrentInIncomingOrder = chapterCards.filter((c) => 'current_chapter_id' in c).map((c) => (c as { current_chapter_id: string }).current_chapter_id);
  const currentOrderOfThose = current.filter((c) => mappedCurrentInIncomingOrder.includes(c.id)).map((c) => c.id);
  const reordered = mappedCurrentInIncomingOrder.length === currentOrderOfThose.length && currentOrderOfThose.some((id, i) => mappedCurrentInIncomingOrder[i] !== id);

  const missingCards = missing.map((c) => ({ role: 'missing' as const, current_chapter_id: c.id, title: c.title, chapter_number: c.chapter_number, current_word_count: (byChapter.get(c.id) ?? []).reduce((n, s) => n + wc(s.content), 0), section_count: (byChapter.get(c.id) ?? []).length }));

  const curSectionsTotal = [...byChapter.values()].reduce((n, arr) => n + arr.length, 0);
  const curWordsTotal = [...byChapter.values()].reduce((n, arr) => n + arr.reduce((m, s) => m + wc(s.content), 0), 0);
  const incSectionsTotal = parsed.chapters.reduce((n, c) => n + c.sections.length, 0);
  const incWordsTotal = parsed.chapters.reduce((n, c) => n + c.sections.reduce((m, s) => m + s.word_count, 0), 0);

  const noChange = modified === 0 && added === 0 && needsReview === 0 && missing.length === 0 && !reordered;
  return revisionResult(
    noChange ? 'UNCHANGED' : 'changed',
    {
      book: { id: r.book.id, title: r.book.title },
      manuscript_hash: manuscriptHash,
      current: { chapters: current.length, sections: curSectionsTotal, words: curWordsTotal },
      incoming: { chapters: parsed.chapters.length, sections: incSectionsTotal, words: incWordsTotal },
      summary: { unchanged, modified, new: added, needs_review: needsReview, missing: missing.length },
      reordered,
      chapters: [...chapterCards, ...missingCards],
      needs_review_indexes: chapterCards.filter((c) => c.role === 'needs_review').map((c) => c.incoming_index),
      note: 'Read-only. On apply, the whole current manuscript is snapshotted to history, then approved changes apply in one transaction. Chapters absent from the upload are kept; only explicitly approved sections are removed. No chapter is deleted.'
    },
    noChange ? 'Uploaded manuscript matches the current manuscript — nothing to apply.'
      : `Manuscript changes: ${modified} modified · ${added} new · ${needsReview} need review · ${missing.length} not in upload${reordered ? ' · order changed' : ''}.`
  );
}

export async function applyManuscriptVersion(
  supabase: SB,
  args: {
    book_id: string; incoming_content: string; expected_manuscript_hash: string;
    mappings?: Record<string, string>; // incoming_index → current_chapter_id | 'new'
    section_removals?: string[];
    chapter_deactivations?: string[]; // current chapter_ids the writer chose to remove
    source?: string; source_filename?: string;
  }
): Promise<ToolResult> {
  if (!(args.incoming_content ?? '').trim()) return revisionResult('BAD_REQUEST', { detail: 'The uploaded manuscript is empty.' });
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });

  const parsed = parseManuscript(args.incoming_content);
  if (parsed.chapters.length === 0) return revisionResult('NO_CHAPTERS', { detail: 'No chapters detected.' });

  const { chapters: current, byChapter } = await fetchManuscript(supabase, args.book_id);
  const liveHash = manuscriptStateHashTS(current, byChapter);
  if (args.expected_manuscript_hash && args.expected_manuscript_hash !== liveHash) {
    return revisionResult('TARGET_CHANGED', { book_id: args.book_id, detail: 'The manuscript changed since it was previewed. Refresh the comparison before applying.' });
  }

  const { matches, missing } = matchChapters(current, byChapter, parsed.chapters);
  const mappings = args.mappings ?? {};
  const removalSet = new Set(args.section_removals ?? []);

  // Resolve each incoming chapter → an existing chapter id or 'new'. needs_review
  // must be resolved by the writer's mapping, else block.
  const resolved: { i: number; target: string | 'new' }[] = [];
  for (let i = 0; i < parsed.chapters.length; i++) {
    const m = matches[i]!;
    const override = mappings[String(i)];
    let target: string | 'new';
    if (override) target = override;
    else if (m.role === 'new') target = 'new';
    else if (m.role === 'needs_review') return revisionResult('NEEDS_RESOLUTION', { detail: 'Some chapters still need a mapping decision.', needs_review_index: i });
    else target = (m as { current_chapter_id: string }).current_chapter_id;
    resolved.push({ i, target });
  }
  // Guard: a current chapter can be targeted by at most one incoming chapter.
  const targetedExisting = resolved.filter((x) => x.target !== 'new').map((x) => x.target);
  if (new Set(targetedExisting).size !== targetedExisting.length) return revisionResult('BAD_REQUEST', { detail: 'Two uploaded chapters map to the same existing chapter.' });

  // Build ops. Incoming chapters take sort_order = their order (0..n-1); kept
  // (missing) chapters keep their relative order appended after.
  const chapter_updates: Record<string, unknown>[] = [];
  const new_chapters: Record<string, unknown>[] = [];
  const section_updates: Record<string, unknown>[] = [];
  const section_inserts: Record<string, unknown>[] = [];
  const section_removals: string[] = [];
  const chapter_reorder: Record<string, unknown>[] = [];
  const section_reorder: Record<string, unknown>[] = [];
  const targetedSet = new Set(targetedExisting);
  const currentChapById = new Map(current.map((c) => [c.id, c]));

  resolved.forEach(({ i, target }) => {
    const inc = parsed.chapters[i]!;
    if (target === 'new') {
      new_chapters.push({ chapter_number: inc.chapter_number, title: inc.title, sort_order: i, sections: inc.sections.map((s, k) => ({ title: null, content: s.content, word_count: s.word_count, sort_order: k })) });
      return;
    }
    // Only write chapter metadata/order when it actually differs.
    const cc = currentChapById.get(target);
    if (cc && (inc.title !== cc.title || inc.chapter_number !== cc.chapter_number || i !== cc.sort_order)) {
      chapter_updates.push({ chapter_id: target, title: inc.title, chapter_number: inc.chapter_number, sort_order: i });
    }
    const curSecs = byChapter.get(target) ?? [];
    const ops = chapterOpsFor(curSecs, chapterBody(inc.sections), removalSet);
    for (const u of ops.updates) section_updates.push(u);
    for (const ins of ops.inserts) section_inserts.push({ chapter_id: target, title: ins.title, content: ins.content, word_count: ins.word_count, sort_order: ins.sort_order });
    for (const ro of ops.reorder) section_reorder.push(ro);
    for (const rem of ops.removals) section_removals.push(rem);
  });
  // kept-missing chapters: keep them, appended in original order (never deleted)
  missing.filter((c) => !targetedSet.has(c.id)).forEach((c, j) => {
    const newOrder = parsed.chapters.length + j;
    if (c.sort_order !== newOrder) chapter_reorder.push({ chapter_id: c.id, sort_order: newOrder });
  });

  // Explicit chapter removals → deactivate (must be active chapters of this book).
  const activeIds = new Set(current.map((c) => c.id));
  const chapterDeactivations = (args.chapter_deactivations ?? []).filter((id) => activeIds.has(id));

  // Nothing actually changes → no write, no snapshot (identical upload).
  if (!chapter_updates.length && !new_chapters.length && !section_updates.length && !section_inserts.length && !section_removals.length && !chapter_reorder.length && !section_reorder.length && !chapterDeactivations.length) {
    return revisionResult('UNCHANGED', { book_id: args.book_id, detail: 'Uploaded manuscript matches the current manuscript; no write performed.' });
  }

  const { data, error } = await supabase.rpc('apply_manuscript_version', {
    p_book_id: args.book_id,
    p_expected_hash: liveHash,
    p_source: args.source ?? '',
    p_source_filename: args.source_filename ?? '',
    p_chapter_updates: chapter_updates,
    p_new_chapters: new_chapters,
    p_section_updates: section_updates,
    p_section_inserts: section_inserts,
    p_section_removals: section_removals,
    p_chapter_reorder: chapter_reorder,
    p_section_reorder: section_reorder,
    p_chapter_deactivations: chapterDeactivations
  });
  if (error) {
    const m = error.message || '';
    const status = /TARGET_CHANGED/.test(m) ? 'TARGET_CHANGED' : /NOT_FOUND/.test(m) ? 'NOT_FOUND' : 'APPLY_FAILED';
    return revisionResult(status, { book_id: args.book_id, detail: 'The manuscript was not changed.', error: m });
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return revisionResult('applied', { book_id: args.book_id, ...res }, 'New manuscript version applied (previous manuscript snapshotted).');
}

export async function listManuscriptVersions(supabase: SB, args: { book_id: string }): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { chapters, byChapter } = await fetchManuscript(supabase, args.book_id);
  const currentWords = [...byChapter.values()].reduce((n, arr) => n + arr.reduce((m, s) => m + wc(s.content), 0), 0);
  const currentSections = [...byChapter.values()].reduce((n, arr) => n + arr.length, 0);
  const { data: rows, error } = await supabase
    .from('manuscript_snapshots')
    .select('id, version_reason, source, source_filename, book_title, chapter_count, section_count, word_count, created_at')
    .eq('book_id', args.book_id)
    .order('created_at', { ascending: false });
  if (error) return revisionResult('LIST_FAILED', { detail: 'Could not load manuscript history.', error: error.message });
  return revisionResult('ok', {
    book: { id: r.book.id, title: r.book.title },
    current: { chapters: chapters.length, sections: currentSections, words: currentWords, content_hash: manuscriptStateHashTS(chapters, byChapter) },
    count: (rows ?? []).length,
    versions: (rows ?? []).map((v) => ({ version_id: v.id, created_at: v.created_at, version_reason: v.version_reason, source: v.source, source_filename: v.source_filename, chapter_count: v.chapter_count, section_count: v.section_count, word_count: v.word_count }))
  }, `${(rows ?? []).length} saved manuscript version(s).`);
}

// --- Manuscript version history: compare + restore --------------------------
// Reads + restores over the SAME manuscript_snapshots that Upload writes. KEEP-
// only: a chapter present now but absent from the snapshot is preserved (never
// deleted). Comparison is by stored chapter_id/section_id (identity); restore is
// snapshot-first and transactional (apply_manuscript_restore RPC).
type SnapSec = { section_id: string; sort_order: number; title: string | null; content: string; word_count: number };

function compareSectionsToSnapshot(currentSecs: CurSection[], snapSecs: SnapSec[]) {
  const cur = orderSections(currentSecs);
  const snap = [...snapSecs].sort((a, b) => a.sort_order - b.sort_order || (a.section_id < b.section_id ? -1 : 1));
  const curById = new Map(cur.map((s) => [s.id, s]));
  const snapById = new Map(snap.map((s) => [s.section_id, s]));
  const entries: Record<string, unknown>[] = [];
  let modified = 0, unchanged = 0, onlyCur = 0, onlySel = 0, renamed = 0;
  for (const sn of snap) {
    const c = curById.get(sn.section_id);
    const selWc = typeof sn.word_count === 'number' ? sn.word_count : wc(sn.content ?? '');
    if (!c) { const diff = computeLineDiff('', sn.content ?? ''); entries.push({ role: 'only_in_selected', section_id: sn.section_id, title: sn.title, selected_word_count: selWc, diff, summary: diffSummary(diff) }); onlySel++; continue; }
    const ren = (c.title ?? '') !== (sn.title ?? '');
    const same = normalizeContent(c.content ?? '') === normalizeContent(sn.content ?? '');
    if (same && !ren) { entries.push({ role: 'unchanged', section_id: sn.section_id, title: c.title ?? sn.title, current_word_count: wc(c.content ?? ''), selected_word_count: selWc }); unchanged++; continue; }
    const diff = same ? [] : computeLineDiff(normalizeContent(c.content ?? ''), normalizeContent(sn.content ?? ''));
    if (ren) renamed++;
    entries.push({ role: 'modified', section_id: sn.section_id, title: sn.title, renamed: ren, current_word_count: wc(c.content ?? ''), selected_word_count: selWc, diff, summary: diffSummary(diff) });
    modified++;
  }
  for (const c of cur) if (!snapById.has(c.id)) { entries.push({ role: 'only_in_current', section_id: c.id, title: c.title, current_word_count: wc(c.content ?? '') }); onlyCur++; }
  const commonCur = cur.filter((s) => snapById.has(s.id)).map((s) => s.id);
  const commonSnap = snap.filter((s) => curById.has(s.section_id)).map((s) => s.section_id);
  const reordered = commonCur.length === commonSnap.length && commonCur.some((id, i) => commonSnap[i] !== id);
  return { entries, summary: { modified, unchanged, only_in_current: onlyCur, only_in_selected: onlySel, renamed }, reordered };
}

export async function previewManuscriptRestore(
  supabase: SB,
  args: { book_id: string; snapshot_id: string }
): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { data: row } = await supabase.from('manuscript_snapshots').select('id, book_id, version_reason, source, source_filename, created_at, snapshot, chapter_count, section_count, word_count').eq('id', args.snapshot_id).maybeSingle();
  if (!row || row.book_id !== args.book_id) return revisionResult('VERSION_NOT_FOUND', { detail: 'That manuscript version was not found for this book.' });

  const { chapters: current, byChapter } = await fetchManuscript(supabase, args.book_id);
  const manuscriptHash = manuscriptStateHashTS(current, byChapter);
  const snap = row.snapshot as { book_title?: string; chapters?: { chapter_id: string; chapter_number: number | null; title: string; sort_order: number; sections: SnapSec[] }[] };
  const snapChapters = [...(snap.chapters ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const currentById = new Map(current.map((c) => [c.id, c]));
  const snapById = new Map(snapChapters.map((c) => [c.chapter_id, c]));
  // A snapshot chapter absent from the ACTIVE manuscript is fine if its row still
  // exists (archived) — it will be REACTIVATED. Only a genuinely missing row blocks.
  const { data: allRows } = await supabase.from('chapters').select('id').eq('book_id', args.book_id);
  const existingIds = new Set((allRows ?? []).map((c) => c.id));

  let chModified = 0, chUnchanged = 0, chRenamed = 0, chReactivate = 0;
  const blocking: string[] = [];
  const chapterCards: Record<string, unknown>[] = [];
  for (const sc of snapChapters) {
    const cur = currentById.get(sc.chapter_id);
    if (!cur) {
      if (existingIds.has(sc.chapter_id)) { chReactivate++; chapterCards.push({ role: 'will_reactivate', chapter_id: sc.chapter_id, title: sc.title, section_count: sc.sections.length, selected_word_count: sc.sections.reduce((n, s) => n + (typeof s.word_count === 'number' ? s.word_count : wc(s.content ?? '')), 0) }); }
      else { blocking.push(sc.chapter_id); chapterCards.push({ role: 'only_in_selected', chapter_id: sc.chapter_id, title: sc.title, section_count: sc.sections.length, needs_reactivation: true }); }
      continue;
    }
    const cmp = compareSectionsToSnapshot(byChapter.get(cur.id) ?? [], sc.sections);
    const renamed = normalizeContent(cur.title ?? '') !== normalizeContent(sc.title ?? '');
    const changed = cmp.summary.modified > 0 || cmp.summary.only_in_current > 0 || cmp.summary.only_in_selected > 0 || cmp.reordered || renamed;
    if (renamed) chRenamed++;
    if (changed) chModified++; else chUnchanged++;
    chapterCards.push({
      role: changed ? 'modified' : 'unchanged', chapter_id: cur.id, title: sc.title, current_title: cur.title, renamed,
      current_word_count: (byChapter.get(cur.id) ?? []).reduce((n, s) => n + wc(s.content), 0),
      selected_word_count: sc.sections.reduce((n, s) => n + (typeof s.word_count === 'number' ? s.word_count : wc(s.content ?? '')), 0),
      section_summary: cmp.summary, section_reordered: cmp.reordered, sections: cmp.entries
    });
  }
  // Active chapters not in the snapshot will be REMOVED from the manuscript
  // (deactivated — reversible), not kept.
  const willRemove = current.filter((c) => !snapById.has(c.id)).map((c) => ({ role: 'will_remove' as const, chapter_id: c.id, title: c.title, chapter_number: c.chapter_number, current_word_count: (byChapter.get(c.id) ?? []).reduce((n, s) => n + wc(s.content), 0), section_count: (byChapter.get(c.id) ?? []).length }));

  const commonCurOrder = current.filter((c) => snapById.has(c.id)).map((c) => c.id);
  const commonSnapOrder = snapChapters.filter((c) => currentById.has(c.chapter_id)).map((c) => c.chapter_id);
  const reordered = commonCurOrder.length === commonSnapOrder.length && commonCurOrder.some((id, i) => commonSnapOrder[i] !== id);

  const canRestore = blocking.length === 0;
  const noChange = chModified === 0 && chRenamed === 0 && chReactivate === 0 && willRemove.length === 0 && blocking.length === 0 && !reordered;

  const curSectionsTotal = [...byChapter.values()].reduce((n, arr) => n + arr.length, 0);
  const curWordsTotal = [...byChapter.values()].reduce((n, arr) => n + arr.reduce((m, s) => m + wc(s.content), 0), 0);
  const selSectionsTotal = snapChapters.reduce((n, c) => n + c.sections.length, 0);
  const selWordsTotal = snapChapters.reduce((n, c) => n + c.sections.reduce((m, s) => m + (typeof s.word_count === 'number' ? s.word_count : wc(s.content ?? '')), 0), 0);

  return revisionResult(
    noChange ? 'UNCHANGED' : 'changed',
    {
      book: { id: r.book.id, title: r.book.title },
      manuscript_hash: manuscriptHash,
      can_restore: canRestore,
      blocking_issues: canRestore ? [] : ['CHAPTER_REACTIVATION_REQUIRED'],
      will_remove_chapters: willRemove.length,
      will_reactivate_chapters: chReactivate,
      selected: { snapshot_id: row.id, created_at: row.created_at, version_reason: row.version_reason, source: row.source, book_title: snap.book_title ?? null, chapters: snapChapters.length, sections: selSectionsTotal, words: selWordsTotal },
      current: { chapters: current.length, sections: curSectionsTotal, words: curWordsTotal },
      summary: { chapters_modified: chModified, chapters_unchanged: chUnchanged, chapters_renamed: chRenamed, will_reactivate: chReactivate, will_remove: willRemove.length, only_in_selected: blocking.length },
      reordered,
      chapters: [...chapterCards, ...willRemove],
      removed_chapters: willRemove.map((c) => ({ chapter_id: c.chapter_id, title: c.title })),
      note: 'Read-only. On restore, the current manuscript is snapshotted, then reconciled to this version: chapters in this version are restored/reactivated, and chapters added later are removed from the active manuscript (reversible — preserved in Version History).'
    },
    noChange ? 'This version matches the current manuscript — nothing to restore.'
      : `Restoring: ${chModified} chapters change · ${chReactivate} return · ${willRemove.length} removed (added later)${blocking.length ? ` · ${blocking.length} cannot be restored` : ''}.`
  );
}

export async function applyManuscriptRestore(
  supabase: SB,
  args: { book_id: string; snapshot_id: string; expected_manuscript_hash: string }
): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { chapters, byChapter } = await fetchManuscript(supabase, args.book_id);
  const liveHash = manuscriptStateHashTS(chapters, byChapter);
  if (args.expected_manuscript_hash && args.expected_manuscript_hash !== liveHash) {
    return revisionResult('TARGET_CHANGED', { book_id: args.book_id, detail: 'The manuscript changed since the comparison was opened. Refresh before restoring.' });
  }
  const { data, error } = await supabase.rpc('apply_manuscript_restore', { p_book_id: args.book_id, p_snapshot_id: args.snapshot_id, p_expected_hash: liveHash });
  if (error) {
    const m = error.message || '';
    const status = /TARGET_CHANGED/.test(m) ? 'TARGET_CHANGED' : /CHAPTER_REACTIVATION_REQUIRED/.test(m) ? 'CHAPTER_REACTIVATION_REQUIRED' : /MALFORMED_SNAPSHOT/.test(m) ? 'MALFORMED_SNAPSHOT' : /VERSION_NOT_FOUND/.test(m) ? 'VERSION_NOT_FOUND' : /NOT_FOUND/.test(m) ? 'NOT_FOUND' : 'RESTORE_FAILED';
    return revisionResult(status, { book_id: args.book_id, detail: 'The manuscript was not changed.', error: m });
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return revisionResult('applied', { book_id: args.book_id, ...res }, 'Manuscript restored (previous manuscript snapshotted).');
}

// --- Review & Continuity ----------------------------------------------------
// Assemble the ACTIVE manuscript + Story-Intelligence data, run the deterministic
// continuity engine, and reconcile candidates against persisted findings by
// stable fingerprint (writer states survive re-runs; a resolved finding reopens
// only if its evidence materially changed). Reads only — never edits prose/canon.
async function assembleReviewInput(supabase: SB, book_id: string) {
  const { data: chapters } = await supabase.from('chapters').select('id, chapter_number, title, sort_order').eq('book_id', book_id).is('archived_at', null);
  const chList = (chapters ?? []) as { id: string; chapter_number: number | null; title: string; sort_order: number }[];
  const chIds = chList.map((c) => c.id);
  const { data: sections } = chIds.length ? await supabase.from('writing_sections').select('id, chapter_id, sort_order, title, content').in('chapter_id', chIds) : { data: [] };
  const [{ data: threads }, { data: canonFacts }, { data: relationships }, { data: timelineEvents }, { data: chars }] = await Promise.all([
    supabase.from('story_threads').select('*').eq('book_id', book_id),
    supabase.from('canon_facts').select('*').eq('book_id', book_id),
    supabase.from('relationships').select('*').eq('book_id', book_id),
    supabase.from('timeline_events').select('*').eq('book_id', book_id),
    supabase.from('characters').select('id, name').eq('book_id', book_id)
  ]);
  const factIds = (canonFacts ?? []).map((f) => f.id);
  const { data: canonConflicts } = factIds.length ? await supabase.from('canon_fact_conflicts').select('*').in('canon_fact_id', factIds) : { data: [] };
  return {
    chapters: chList,
    sections: (sections ?? []) as { id: string; chapter_id: string; sort_order: number; title: string | null; content: string }[],
    threads: (threads ?? []) as never[],
    canonFacts: (canonFacts ?? []) as never[],
    canonConflicts: (canonConflicts ?? []) as never[],
    relationships: (relationships ?? []) as never[],
    timelineEvents: (timelineEvents ?? []) as never[],
    characterNames: new Map((chars ?? []).map((c) => [c.id, c.name] as const))
  };
}

// Shared reconcile: upsert candidates by fingerprint; writer states persist; a
// resolved finding reopens only on material evidence change. Deletes OPEN
// findings (of the given sources) no longer detected — only on a whole-book run.
async function reconcileFindings(supabase: SB, book_id: string, candidates: FindingCandidate[], opts: { sources: Set<string>; chapterScoped: boolean }) {
  const { data: existingRows } = await supabase.from('review_findings').select('id, fingerprint, status, evidence_hash, source').eq('book_id', book_id);
  const existing = new Map((existingRows ?? []).map((f) => [f.fingerprint, f]));
  const keptFps = new Set(candidates.map((c) => c.fingerprint));
  for (const c of candidates) {
    const base = {
      book_id, chapter_id: c.chapter_id, finding_type: c.finding_type, level: c.level,
      title: c.title, explanation: c.explanation, question: c.question, evidence: c.evidence, entities: c.entities,
      confidence: c.confidence, fingerprint: c.fingerprint, evidence_hash: c.evidence_hash, source: c.source ?? 'deterministic'
    };
    const ex = existing.get(c.fingerprint);
    if (!ex) { await supabase.from('review_findings').insert({ ...base, status: 'open' }); continue; }
    if (ex.status === 'resolved') {
      if (ex.evidence_hash !== c.evidence_hash) await supabase.from('review_findings').update({ ...base, status: 'open' }).eq('id', ex.id);
    } else {
      await supabase.from('review_findings').update(base).eq('id', ex.id); // intentional/open/watch keep status, refresh
    }
  }
  if (!opts.chapterScoped) {
    const stale = (existingRows ?? []).filter((f) => f.status === 'open' && opts.sources.has(f.source ?? 'deterministic') && !keptFps.has(f.fingerprint)).map((f) => f.id);
    if (stale.length) await supabase.from('review_findings').delete().in('id', stale);
  }
}

function deterministicSubjectKeys(cands: FindingCandidate[]): Set<string> {
  return new Set(cands.map((c) => `${c.finding_type}:${(c.entities[0]?.name ?? c.title).toLowerCase().slice(0, 40)}`));
}

export async function runReview(supabase: SB, args: { book_id: string; chapter_id?: string }): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const input = await assembleReviewInput(supabase, args.book_id);
  let candidates: FindingCandidate[] = computeContinuityFindings(input as never);
  const chapterScoped = !!args.chapter_id;
  if (args.chapter_id) candidates = candidates.filter((c) => c.chapter_id === args.chapter_id || c.evidence.some((e) => e.chapter_id === args.chapter_id));
  await reconcileFindings(supabase, args.book_id, candidates, { sources: new Set(['deterministic']), chapterScoped });
  return listReviewFindings(supabase, { book_id: args.book_id });
}

// Whole-manuscript VOICE CONSISTENCY — deterministic, read-only. Builds a
// book-wide voice profile from the ACTIVE sections and surfaces the sections
// that read most differently from the rest. No LLM, no writes, no persistence.
export async function getVoiceReport(supabase: SB, args: { book_id: string }): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { data: chapters } = await supabase.from('chapters').select('id, chapter_number, title, sort_order').eq('book_id', args.book_id).is('archived_at', null);
  const chList = (chapters ?? []) as { id: string; chapter_number: number | null; title: string; sort_order: number }[];
  const chById = new Map(chList.map((c) => [c.id, c]));
  const chIds = chList.map((c) => c.id);
  const { data: sections } = chIds.length
    ? await supabase.from('writing_sections').select('id, chapter_id, sort_order, content').in('chapter_id', chIds)
    : { data: [] };
  const secs = (sections ?? []) as { id: string; chapter_id: string; sort_order: number; content: string }[];
  const input: VoiceSectionInput[] = secs
    .map((s) => ({ s, ch: chById.get(s.chapter_id) }))
    .filter((x): x is { s: typeof secs[number]; ch: NonNullable<ReturnType<typeof chById.get>> } => !!x.ch)
    .sort((a, b) => a.ch.sort_order - b.ch.sort_order || a.s.sort_order - b.s.sort_order)
    .map(({ s, ch }) => ({ section_id: s.id, chapter_id: s.chapter_id, chapter_number: ch.chapter_number, title: ch.title, content: s.content ?? '' }));
  const report = computeVoiceConsistency(input);
  return revisionResult('ok', { book: { id: r.book.id, title: r.book.title }, ...report },
    report.status === 'ok' ? report.summary.note : (report.detail ?? 'Not enough written yet to compare voice.'));
}

// Whole-manuscript PHRASING check — deterministic, read-only. Surfaces the
// generic/overwritten-prose tells (the "not X, but Y" cadence, significance
// words, filler, repeated openers) with the actual lines. No LLM, no writes.
export async function getPhrasingReport(supabase: SB, args: { book_id: string }): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { data: chapters } = await supabase.from('chapters').select('id, chapter_number, title, sort_order').eq('book_id', args.book_id).is('archived_at', null);
  const chList = (chapters ?? []) as { id: string; chapter_number: number | null; title: string; sort_order: number }[];
  const chById = new Map(chList.map((c) => [c.id, c]));
  const chIds = chList.map((c) => c.id);
  const { data: sections } = chIds.length
    ? await supabase.from('writing_sections').select('id, chapter_id, sort_order, content').in('chapter_id', chIds)
    : { data: [] };
  const { data: chars } = await supabase.from('characters').select('name').eq('book_id', args.book_id);
  const secs = (sections ?? []) as { id: string; chapter_id: string; sort_order: number; content: string }[];
  const input: PhrasingSectionInput[] = secs
    .map((s) => ({ s, ch: chById.get(s.chapter_id) }))
    .filter((x): x is { s: typeof secs[number]; ch: NonNullable<ReturnType<typeof chById.get>> } => !!x.ch)
    .sort((a, b) => a.ch.sort_order - b.ch.sort_order || a.s.sort_order - b.s.sort_order)
    .map(({ s, ch }) => ({ section_id: s.id, chapter_id: s.chapter_id, chapter_number: ch.chapter_number, title: ch.title, content: s.content ?? '' }));
  const report = computePhrasing(input, (chars ?? []).map((c) => c.name));
  return revisionResult('ok', { book: { id: r.book.id, title: r.book.title }, ...report }, report.note);
}

export async function listReviewFindings(supabase: SB, args: { book_id: string }): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { data: rows, error } = await supabase.from('review_findings').select('*').eq('book_id', args.book_id).order('created_at', { ascending: true });
  if (error) return revisionResult('LIST_FAILED', { detail: 'Could not load review findings.', error: error.message });
  const findings = (rows ?? []) as unknown[];
  const attention = (rows ?? []).filter((f) => f.status === 'open' || f.status === 'watch');
  const byType = (t: string) => attention.filter((f) => f.finding_type === t).length;
  return revisionResult('ok', {
    book: { id: r.book.id, title: r.book.title },
    findings,
    summary: {
      worth_checking: attention.filter((f) => f.level === 'worth_checking').length,
      likely_conflict: attention.filter((f) => f.level === 'likely_conflict').length,
      open_question: attention.filter((f) => f.level === 'open_question').length,
      open_threads: byType('plot_thread') + byType('setup_payoff'),
      relationships: byType('relationship'),
      total_attention: attention.length,
      resolved: (rows ?? []).filter((f) => f.status === 'resolved').length,
      intentional: (rows ?? []).filter((f) => f.status === 'intentional').length
    }
  }, `${attention.length} finding(s) worth attention.`);
}

export async function setReviewFindingStatus(supabase: SB, args: { book_id: string; finding_id: string; status: 'open' | 'intentional' | 'resolved' | 'watch' }): Promise<ToolResult> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { data, error } = await supabase.from('review_findings').update({ status: args.status }).eq('id', args.finding_id).eq('book_id', args.book_id).select('id, status').maybeSingle();
  if (error) return revisionResult('UPDATE_FAILED', { detail: 'Could not update the finding.', error: error.message });
  if (!data) return revisionResult('NOT_FOUND', { detail: 'Finding not found or not permitted.' });
  return revisionResult('ok', { finding_id: data.id, status: data.status }, `Finding marked ${args.status}.`);
}

// Build the DeepInput digest shape from assembled review data.
function toDeepInput(input: Awaited<ReturnType<typeof assembleReviewInput>>): DeepInput {
  const chById = new Map(input.chapters.map((c) => [c.id, c]));
  return {
    chapters: input.chapters,
    sections: input.sections,
    threads: (input.threads as unknown as { title: string; status: string; description: string | null }[]).map((t) => ({ title: t.title, status: t.status, description: t.description })),
    relationships: (input.relationships as unknown as { character_a_id: string; character_b_id: string; current_status: string | null; unresolved_tension: string | null }[]).map((r) => ({ a: input.characterNames.get(r.character_a_id) ?? 'Someone', b: input.characterNames.get(r.character_b_id) ?? 'someone', current_status: r.current_status, unresolved_tension: r.unresolved_tension })),
    canonFacts: (input.canonFacts as unknown as { subject_type: string; subject_id: string | null; fact: string }[]).map((f) => ({ subject: (f.subject_id && input.characterNames.get(f.subject_id)) || f.subject_type, fact: f.fact })),
    timeline: (input.timelineEvents as unknown as { event_order: number; chapter_id: string | null; event_description: string }[]).map((e) => ({ order: e.event_order, chapter_number: e.chapter_id ? chById.get(e.chapter_id)?.chapter_number ?? null : null, description: e.event_description })),
    characterNames: [...input.characterNames.values()]
  };
}

type AiGenerator = (system: string, digest: string) => Promise<RawAiResult>;
// The live generator carries usage metadata (feature + book) so the shared
// client can log the call and enforce the daily cap. Deep Review gets a longer
// timeout than the default — a whole-book pass takes ~78s.
function makeLiveAiGenerator(supabase: SB, bookId: string): AiGenerator {
  return (system, digest) =>
    callOpenAIStructured<RawAiResult>({
      system,
      messages: [{ role: 'user', content: `Manuscript digest follows. Propose continuity candidates with verbatim quotes as evidence.\n\n${digest}` }],
      toolName: 'continuity_candidates', toolDescription: 'Story-consistency candidate issues with verbatim evidence quotes.',
      schema: DEEP_REVIEW_SCHEMA, maxTokens: 12000,
      meta: { supabase, feature: 'deep_review', bookId, timeoutMs: 180_000 }
    });
}

// Shared Deep-Review context: resolve+own the book, assemble the ACTIVE
// manuscript + Story-Intelligence data, run the deterministic pass, and compute
// the manuscript state hash. Used identically by the STANDALONE path (which
// then calls OpenAI to generate candidates) and the MCP HOST path (which returns
// this context so the host generates candidates). No provider call here.
// Bump this whenever the deep-review LOGIC changes (methodology, verifier,
// guards). It is folded into the review_ai_runs cache key so a code change
// invalidates the hash gate — the next deep run re-runs instead of serving
// findings produced by the old engine. (v2: temporal-progression guard.)
const REVIEW_ENGINE_VERSION = 'v2';
const gateKey = (hash: string) => `${REVIEW_ENGINE_VERSION}:${hash}`;

type DeepReviewContext = { input: Awaited<ReturnType<typeof assembleReviewInput>>; det: FindingCandidate[]; hash: string; scope: string; chapterScoped: boolean };
async function buildDeepReviewContext(
  supabase: SB,
  args: { book_id: string; chapter_id?: string }
): Promise<{ status: 'ok'; book: { id: string; title: string }; ctx: DeepReviewContext } | { status: 'NOT_FOUND' }> {
  const r = await resolveBook(supabase, args.book_id);
  if (r.status !== 'ok') return { status: 'NOT_FOUND' };
  const input = await assembleReviewInput(supabase, args.book_id);
  const chapterScoped = !!args.chapter_id;
  let det = computeContinuityFindings(input as never);
  if (args.chapter_id) det = det.filter((c) => c.chapter_id === args.chapter_id || c.evidence.some((e) => e.chapter_id === args.chapter_id));
  const scope = args.chapter_id ?? 'book';
  const hash = manuscriptStateHashTS(input.chapters as never, new Map((input.sections as { id: string; chapter_id: string; sort_order: number; title: string | null; content: string }[]).reduce((m, s) => { const a = m.get(s.chapter_id) ?? []; a.push(s as never); m.set(s.chapter_id, a); return m; }, new Map<string, never[]>())));
  return { status: 'ok', book: { id: r.book.id, title: r.book.title }, ctx: { input, det, hash, scope, chapterScoped } };
}

// Optional AI (Deep) review — STANDALONE (BookBuild.com) path. Runs the
// deterministic pass, then — only when the manuscript changed since the last AI
// run (hash gate) — a direct OpenAI candidate pass that is evidence-verified,
// deduped vs deterministic, and reconciled through the same review_findings
// pipeline. AI failure preserves deterministic findings. (MCP hosts should use
// get_deep_review_context + verify_and_persist_review_candidates, which cost no
// OpenAI.)
export async function runDeepReview(
  supabase: SB,
  args: { book_id: string; chapter_id?: string },
  _generate?: AiGenerator
): Promise<ToolResult> {
  const built = await buildDeepReviewContext(supabase, args);
  if (built.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { input, det, hash, scope, chapterScoped } = built.ctx;

  // Hash gate: skip the LLM if the active manuscript hasn't changed since last AI run.
  const { data: lastRun } = await supabase.from('review_ai_runs').select('manuscript_hash').eq('book_id', args.book_id).eq('scope', scope).maybeSingle();
  const { count: aiCount } = await supabase.from('review_findings').select('id', { count: 'exact', head: true }).eq('book_id', args.book_id).eq('source', 'ai');
  const upToDate = !!lastRun && lastRun.manuscript_hash === gateKey(hash) && (aiCount ?? 0) > 0;

  const generate = _generate ?? makeLiveAiGenerator(supabase, args.book_id);
  let aiCandidates: FindingCandidate[] = [];
  let aiRan = false, aiFailed = false, aiLimitReached = false;
  if (!upToDate) {
    try {
      const digest = buildDeepReviewDigest(toDeepInput(input));
      const raw = await generate(DEEP_REVIEW_SYSTEM, digest);
      let sections = input.sections as { id: string; chapter_id: string; sort_order: number; title: string | null; content: string }[];
      if (args.chapter_id) sections = sections.filter((s) => s.chapter_id === args.chapter_id);
      aiCandidates = verifyAiCandidates(toDeepInput(input), sections as never, raw, deterministicSubjectKeys(det));
      if (args.chapter_id) aiCandidates = aiCandidates.filter((c) => c.chapter_id === args.chapter_id || c.evidence.some((e) => e.chapter_id === args.chapter_id));
      aiRan = true;
      await supabase.from('review_ai_runs').upsert({ book_id: args.book_id, scope, manuscript_hash: gateKey(hash), source: 'openai' }, { onConflict: 'book_id,scope' });
    } catch (err) {
      aiFailed = true; // §26: preserve deterministic results, surface nothing raw
      if (isAiUsageLimitError(err)) aiLimitReached = true; // daily cap hit — still return deterministic
    }
  }

  // Reconcile deterministic + (fresh or retained) AI candidates. When the AI
  // pass didn't run (up-to-date or failed), don't delete existing AI findings.
  const sources = new Set<string>(['deterministic']);
  if (aiRan) sources.add('ai');
  await reconcileFindings(supabase, args.book_id, [...det, ...aiCandidates], { sources, chapterScoped });

  const listed = await listReviewFindings(supabase, { book_id: args.book_id });
  const sc2 = listed.structuredContent as Record<string, unknown>;
  return revisionResult('ok', { ...sc2, deep: true, ai_ran: aiRan, ai_failed: aiFailed, ai_limit_reached: aiLimitReached, ai_up_to_date: upToDate }, (listed.structuredContent as { summary?: { total_attention?: number } })?.summary?.total_attention != null ? `${(listed.structuredContent as { summary: { total_attention: number } }).summary.total_attention} finding(s) worth attention${aiLimitReached ? ' (daily AI limit reached)' : aiFailed ? ' (deep review unavailable)' : ''}.` : 'Review complete.');
}

// --- MCP HOST-MODE Deep Review (no OpenAI) -----------------------------------
// get_deep_review_context: return everything an MCP host (Claude/ChatGPT) needs
// to generate continuity candidates ITSELF — deterministic review summary,
// bounded manuscript digest, story-state context, the candidate schema, and the
// methodology. Read-only: NO OpenAI call, NO persistence, NO prose/canon writes.
export async function getDeepReviewContext(supabase: SB, args: { book_id: string; chapter_id?: string }): Promise<ToolResult> {
  const built = await buildDeepReviewContext(supabase, args);
  if (built.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { input, det, hash, scope } = built.ctx;
  const digest = buildDeepReviewDigest(toDeepInput(input));
  const { data: lastRun } = await supabase.from('review_ai_runs').select('manuscript_hash').eq('book_id', args.book_id).eq('scope', scope).maybeSingle();
  const { count: aiCount } = await supabase.from('review_findings').select('id', { count: 'exact', head: true }).eq('book_id', args.book_id).eq('source', 'ai');
  const aiUpToDate = !!lastRun && lastRun.manuscript_hash === gateKey(hash) && (aiCount ?? 0) > 0;
  const hostInstructions = DEEP_REVIEW_SYSTEM +
    ` You are generating these candidates yourself (no external model is called). Return at most ${MAX_HOST_CANDIDATES} candidates matching candidate_schema. Do not restate issues already listed in deterministic_findings. Every candidate MUST quote the digest verbatim in evidence_targets; the server re-verifies each quote against the real manuscript and discards anything it cannot locate. Then call verify_and_persist_review_candidates with book_id, this scope, this manuscript_hash (as expected_manuscript_hash), and your candidates.`;
  return revisionResult('ok', {
    book: built.book,
    scope,
    chapter_id: args.chapter_id ?? null,
    manuscript_hash: hash,
    ai_up_to_date: aiUpToDate,
    deterministic_summary: { total: det.length, by_level: { worth_checking: det.filter((c) => c.level === 'worth_checking').length, likely_conflict: det.filter((c) => c.level === 'likely_conflict').length, open_question: det.filter((c) => c.level === 'open_question').length } },
    deterministic_findings: det.slice(0, 50).map((c) => ({ finding_type: c.finding_type, level: c.level, title: c.title })),
    digest,
    candidate_schema: DEEP_REVIEW_SCHEMA,
    max_candidates: MAX_HOST_CANDIDATES,
    instructions: hostInstructions,
    next_tool: 'verify_and_persist_review_candidates'
  }, 'Deep review context assembled — the host generates candidates, then calls verify_and_persist_review_candidates.');
}

// verify_and_persist_review_candidates: take UNTRUSTED host-generated candidates,
// verify their evidence against the CURRENT active manuscript with the SAME
// deterministic verifier used for OpenAI candidates, dedupe vs deterministic,
// and reconcile into the SAME review_findings (writer states persist). NO OpenAI
// call → no ai_usage_log row and unaffected by OpenAI cost caps.
export async function verifyAndPersistReviewCandidates(
  supabase: SB,
  args: { book_id: string; scope?: string; expected_manuscript_hash: string; candidates: unknown }
): Promise<ToolResult> {
  const chapterId = args.scope && args.scope !== 'book' ? args.scope : undefined;
  const built = await buildDeepReviewContext(supabase, { book_id: args.book_id, chapter_id: chapterId });
  if (built.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  const { input, det, hash, scope, chapterScoped } = built.ctx;

  // Scope validation: a chapter scope must name a real ACTIVE chapter of THIS book.
  if (chapterId && !input.chapters.some((c) => c.id === chapterId)) return revisionResult('BAD_REQUEST', { detail: 'scope must be "book" or an active chapter id of this book.' });
  // Stale-state protection (§7): never verify against a different manuscript.
  if (!args.expected_manuscript_hash) return revisionResult('BAD_REQUEST', { detail: 'expected_manuscript_hash is required (from get_deep_review_context).' });
  if (args.expected_manuscript_hash !== hash) return revisionResult('REVIEW_CONTEXT_CHANGED', { detail: 'The manuscript changed since context was fetched. Call get_deep_review_context again and re-verify.', current_manuscript_hash: hash });
  if (!Array.isArray(args.candidates) || args.candidates.length === 0) return revisionResult('BAD_REQUEST', { detail: 'Provide a non-empty candidates array.' });

  // Sanitize UNTRUSTED input, then run the SAME evidence verification as OpenAI.
  const { candidates, rejectedMalformed, truncated } = sanitizeHostCandidates(args.candidates);
  let sections = input.sections as { id: string; chapter_id: string; sort_order: number; title: string | null; content: string }[];
  if (chapterId) sections = sections.filter((s) => s.chapter_id === chapterId);
  const { kept, discarded } = verifyAiCandidatesDetailed(toDeepInput(input), sections as never, { candidates }, deterministicSubjectKeys(det));
  let ai = kept;
  if (chapterId) ai = ai.filter((c) => c.chapter_id === chapterId || c.evidence.some((e) => e.chapter_id === chapterId));

  // Reconcile deterministic + verified host AI candidates through the SAME
  // pipeline (dedup/fingerprint/writer-state preservation), then record the run.
  const existingFps = new Set(kept.map((c) => c.fingerprint));
  const { data: priorAi } = await supabase.from('review_findings').select('fingerprint').eq('book_id', args.book_id).eq('source', 'ai');
  const updatedExisting = (priorAi ?? []).filter((p) => existingFps.has(p.fingerprint)).length;
  await reconcileFindings(supabase, args.book_id, [...det, ...ai], { sources: new Set(['deterministic', 'ai']), chapterScoped });
  await supabase.from('review_ai_runs').upsert({ book_id: args.book_id, scope, manuscript_hash: gateKey(hash), source: 'mcp_host' }, { onConflict: 'book_id,scope' });

  const listed = await listReviewFindings(supabase, { book_id: args.book_id });
  const sc2 = listed.structuredContent as Record<string, unknown>;
  return revisionResult('ok', {
    ...sc2,
    deep: true,
    source: 'mcp_host',
    manuscript_hash: hash,
    deterministic_included: true,
    candidates_received: args.candidates.length,
    candidates_persisted: ai.length,
    candidates_rejected_malformed: rejectedMalformed,
    candidates_truncated: truncated,
    updated_existing: updatedExisting,
    discarded_count: discarded.length,
    discarded
  }, `${ai.length} host candidate(s) verified and persisted; ${discarded.length + rejectedMalformed} discarded.`);
}

// Propose a canon fact from a finding (writer-approved via story_bible_proposals).
export async function proposeCanonFromFinding(supabase: SB, args: { book_id: string; finding_id: string; fact: string }): Promise<ToolResult> {
  const rb = await resolveBook(supabase, args.book_id);
  if (rb.status !== 'ok') return revisionResult('NOT_FOUND', { detail: 'Book not found or not permitted.' });
  if (!(args.fact ?? '').trim()) return revisionResult('BAD_REQUEST', { detail: 'Provide the fact to add.' });
  const { data: finding } = await supabase.from('review_findings').select('id, chapter_id, evidence, entities').eq('id', args.finding_id).eq('book_id', args.book_id).maybeSingle();
  if (!finding) return revisionResult('NOT_FOUND', { detail: 'Finding not found or not permitted.' });
  const ev = (finding.evidence as { context?: string }[] | null) ?? [];
  const { data: proposal, error } = await supabase.from('story_bible_proposals').insert({
    book_id: args.book_id,
    chapter_id: finding.chapter_id,
    proposal_type: 'canon_fact',
    payload: { fact: args.fact.trim(), source: 'review_finding', review_finding_id: args.finding_id },
    supporting_excerpt: ev[0]?.context ?? null,
    dedupe_key: `review:${args.finding_id}:${args.fact.trim().slice(0, 60).toLowerCase()}`,
    status: 'pending'
  } as never).select('id, status').maybeSingle();
  if (error || !proposal) return revisionResult('PROPOSE_FAILED', { detail: 'Could not create the canon proposal.', error: error?.message });
  return revisionResult('ok', { proposal_id: proposal.id, proposal_status: proposal.status }, 'Canon proposal created (pending your approval).');
}

// --- apply_paragraph_revision (THE ONLY WRITE TOOL) -------------------------
// Persists ONE writer-approved paragraph replacement. It performs NO literary
// reasoning — the host decides passage/diagnosis/replacement and the writer
// approves; this tool only verifies the target against CURRENT text, snapshots
// the pre-edit section into the existing section_versions history, then applies
// the exact single-paragraph replacement. Stale/mismatch/relationship failures
// return a structured status and write NOTHING. Snapshot is created BEFORE the
// update so the section can never change without its prior version persisted.
export async function applyParagraphRevision(
  supabase: SB,
  args: {
    book_id: string;
    section_id: string;
    chapter_id?: string;
    passage_anchor: string; // "<section_id>:pN:<hash>" from get_prose_signals
    expected_original_text?: string;
    approved_replacement_text: string;
    reason?: string;
    classification?: string;
    source?: string;
  }
): Promise<ToolResult> {
  const replacement = args.approved_replacement_text ?? '';
  if (!replacement.trim()) return revisionResult('BAD_REQUEST', { detail: 'approved_replacement_text is empty. This tool replaces a paragraph with approved text; it does not delete paragraphs.' });

  // Parse anchor (uuid has no colons, so the last two segments are pN and hash).
  const parts = args.passage_anchor.split(':');
  if (parts.length < 3) return revisionResult('BAD_REQUEST', { detail: 'passage_anchor must look like "<section_id>:pN:<hash>".' });
  const anchorHash = parts[parts.length - 1]!;
  const expectedIndex = Number((parts[parts.length - 2] ?? '').replace(/^p/, ''));
  const anchorSid = parts.slice(0, parts.length - 2).join(':');
  if (anchorSid !== args.section_id) return revisionResult('BAD_REQUEST', { detail: 'passage_anchor does not belong to section_id.' });

  // 1. Re-fetch CURRENT section (RLS-scoped: a non-owner sees nothing → NOT_FOUND).
  const { data: section } = await supabase
    .from('writing_sections')
    .select('id, chapter_id, content')
    .eq('id', args.section_id)
    .maybeSingle();
  if (!section) return revisionResult('NOT_FOUND', { section_id: args.section_id, detail: 'Section not found or not permitted.' });

  // 2. Validate book/chapter relationship explicitly (independent of RLS).
  if (args.chapter_id && args.chapter_id !== section.chapter_id) return revisionResult('WRONG_RELATIONSHIP', { detail: 'chapter_id does not own this section.' });
  const { data: chapter } = await supabase.from('chapters').select('id, book_id').eq('id', section.chapter_id).maybeSingle();
  if (!chapter || chapter.book_id !== args.book_id) return revisionResult('WRONG_RELATIONSHIP', { detail: 'section does not belong to book_id.' });

  // 3. Recompute anchors from CURRENT text; locate by hash (index disambiguates
  //    duplicates). Never fuzzy-match, never fall back to index alone.
  const content = section.content ?? '';
  const paras = splitParagraphs(args.section_id, content);
  const byHash = paras.filter((p) => p.anchor.text_hash === anchorHash);
  let target: (typeof paras)[number] | undefined;
  if (byHash.length === 0) {
    return revisionResult('TARGET_CHANGED', { section_id: args.section_id, detail: 'The passage changed since it was reviewed; its anchor no longer matches the current text. Reload the current version before editing.' });
  } else if (byHash.length === 1) {
    target = byHash[0];
  } else {
    target = byHash.find((p) => p.anchor.index === expectedIndex);
    if (!target) return revisionResult('AMBIGUOUS_TARGET', { detail: 'Multiple identical paragraphs match; the anchor index no longer identifies exactly one. Reload before editing.' });
  }
  if (!target) return revisionResult('TARGET_CHANGED', { section_id: args.section_id, detail: 'Could not resolve the anchored paragraph in the current text.' });

  // 4. Confirm the current paragraph still matches the expected original text.
  if (args.expected_original_text && normalizeText(target.text) !== normalizeText(args.expected_original_text)) {
    return revisionResult('WRONG_ORIGINAL', { section_id: args.section_id, current_excerpt: target.anchor.excerpt, detail: 'Current paragraph text does not match expected_original_text. No change made.' });
  }

  const newContent = content.slice(0, target.anchor.char_start) + replacement.trim() + content.slice(target.anchor.char_end);

  // 5. SNAPSHOT the pre-edit content FIRST (reuses section_versions). If this
  //    fails, we do NOT touch the manuscript.
  const { data: snap, error: snapErr } = await supabase
    .from('section_versions')
    .insert({ section_id: args.section_id, content, version_reason: 'before_ai_edit' })
    .select('id, created_at')
    .single();
  if (snapErr || !snap) return revisionResult('SNAPSHOT_FAILED', { detail: 'Could not create the pre-edit snapshot; the manuscript was not changed.', error: snapErr?.message });

  // 6. Apply the exact single-paragraph replacement (only this section row).
  const { data: updated, error: updErr } = await supabase
    .from('writing_sections')
    .update({ content: newContent, word_count: wc(newContent) })
    .eq('id', args.section_id)
    .select('updated_at, word_count')
    .single();
  if (updErr || !updated) return revisionResult('UPDATE_FAILED', { snapshot_version_id: snap.id, detail: 'Snapshot saved but the update failed; the manuscript is unchanged and recoverable.', error: updErr?.message });

  return revisionResult(
    'applied',
    {
      section_id: args.section_id,
      replaced_anchor: { id: target.anchor.id, index: target.anchor.index, text_hash: target.anchor.text_hash },
      previous_excerpt: target.anchor.excerpt,
      new_excerpt: normalizeText(replacement).slice(0, 120),
      snapshot_version_id: snap.id,
      snapshot_reason: 'before_ai_edit',
      word_count: updated.word_count,
      updated_at: updated.updated_at,
      source: args.source ?? 'targeted_revision',
      classification: args.classification ?? null
    },
    'Revision applied (pre-edit version snapshotted).'
  );
}

// --- get_prose_signals ------------------------------------------------------
// Deterministic Prose & Voice Health + Targeted Revision foundation. Splits a
// section into stable paragraph anchors and emits objective signals + stats,
// plus a runtime voice baseline from other (approved) sections. NO literary
// verdicts and NO LLM — the host interprets (CRAFT / VOICE DRIFT / AUTHOR
// PREFERENCE + KEEP/TRIM/REWORK/CUT_CANDIDATE/MOVE); the writer decides.
export async function getProseSignals(
  supabase: SB,
  args: { section_id: string; baseline_sample?: number }
): Promise<ToolResult> {
  const resolved = await resolveSection(supabase, args.section_id);
  if (!resolved) return fail('Section not found (or not yours).');
  const { bookId } = resolved;
  const content = resolved.section.content ?? '';

  const { data: chapters } = await supabase.from('chapters').select('id').eq('book_id', bookId).is('archived_at', null);
  const chapterIds = (chapters ?? []).map((c) => c.id);
  const { data: sampleSecs } = chapterIds.length
    ? await supabase
        .from('writing_sections')
        .select('id, content')
        .in('chapter_id', chapterIds)
        .neq('id', args.section_id)
        .limit(args.baseline_sample ?? 8)
    : { data: [] };
  const excerpts = (sampleSecs ?? []).map((s) => s.content).filter(Boolean);
  const baseline = computeVoiceBaseline(excerpts);

  const { data: chars } = await supabase.from('characters').select('name').eq('book_id', bookId);
  const characterNames = (chars ?? []).map((c) => c.name);

  const report = analyzeSectionProse(args.section_id, content, { baseline, characterNames });

  const active_modules: MethodologyModuleId[] = selectActiveModules({
    scope: 'section',
    focus: 'prose_voice',
    signals: { hasUnresolvedThreads: false, hasRelationships: false, hasCharacters: characterNames.length > 0 }
  });

  const structured = {
    ...report,
    guidance: { active_modules, text: buildGuidanceText(active_modules) },
    provenance_note:
      'Signals and stats are objective evidence, not judgments. Voice baseline is ai_derived inference (not canon, not an AI-detection claim). Literary interpretation (CRAFT / VOICE DRIFT / AUTHOR PREFERENCE) is the host model’s; the writer decides. Nothing is rewritten or saved here.',
    meta: { llm_used: false, assembled_by: 'analyzeSectionProse (deterministic)' }
  };

  const totalSignals = report.paragraphs.reduce((n, p) => n + p.signals.length, 0);
  const headline = `Prose signals: ${report.paragraphs.length} paragraph(s), ${totalSignals} objective signal(s); voice baseline ${baseline ? 'from ' + baseline.sample_paragraphs + ' paragraph(s)' : 'unavailable'}.`;
  return ok(headline, structured);
}

// --- search_manuscript ------------------------------------------------------
// Deterministic, story-wide prose EVIDENCE retrieval (distinct from
// get_writing_context, which is local to one section). Given OR-separated
// terms, it returns the chapters/sections that contain them with a short
// excerpt window around the first match — so the host can pull a relevant
// setup many chapters back (e.g. the Ch4 bee origin) without loading the whole
// manuscript. No LLM. This SUPPLIES evidence; it does not interpret it.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function searchManuscript(
  supabase: SB,
  args: { book_id: string; query: string; limit?: number; near_chapter?: number }
): Promise<ToolResult> {
  const terms = (args.query ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  if (!terms.length) return fail('Provide a query with at least one term of 3+ characters (terms can be OR-separated, e.g. "bee|swarm|honey").');

  const { data: chapters } = await supabase
    .from('chapters')
    .select('id, chapter_number')
    .eq('book_id', args.book_id)
    .is('archived_at', null);
  const numById = new Map((chapters ?? []).map((c) => [c.id, c.chapter_number] as const));
  const chapterIds = (chapters ?? []).map((c) => c.id);
  if (!chapterIds.length) return ok('No chapters in this book.', { query: args.query, terms, matches: [] });

  const orExpr = terms.map((t) => `content.ilike.%${t.replace(/[%,]/g, '')}%`).join(',');
  const { data: secs, error } = await supabase
    .from('writing_sections')
    .select('id, chapter_id, content')
    .in('chapter_id', chapterIds)
    .or(orExpr);
  if (error) return fail(`Search failed: ${error.message}`);

  const re = new RegExp(terms.map(escapeRe).join('|'), 'i');
  // Count matches per section so more-on-topic passages can win over a lone
  // common-word hit (helps when an auto-derived query mixes distinctive and
  // common terms). When `near_chapter` is given, closeness to it is the primary
  // sort — so late-book "what's next" reasoning surfaces recent passages instead
  // of the earliest chapters. Otherwise sort by hit-count then chapter order.
  const near = args.near_chapter;
  const matches = (secs ?? [])
    .map((s) => {
      const idx = s.content.search(re);
      const start = Math.max(0, idx - 90);
      const hits = (s.content.match(new RegExp(re.source, 'gi')) ?? []).length;
      return {
        chapter_number: numById.get(s.chapter_id) ?? null,
        section_id: s.id,
        hits,
        excerpt: s.content.slice(start, start + 260).replace(/\s+/g, ' ').trim()
      };
    })
    .sort((a, b) => {
      if (near != null) {
        const da = Math.abs((a.chapter_number ?? 0) - near);
        const db = Math.abs((b.chapter_number ?? 0) - near);
        if (da !== db) return da - db;
      }
      if (b.hits !== a.hits) return b.hits - a.hits;
      return (a.chapter_number ?? 0) - (b.chapter_number ?? 0);
    })
    .slice(0, args.limit ?? 8);

  return ok(
    `${matches.length} passage(s) matching /${terms.join('|')}/i${near != null ? ` (nearest chapter ${near} first)` : ''}.`,
    { query: args.query, terms, near_chapter: near ?? null, matches, meta: { llm_used: false } }
  );
}
