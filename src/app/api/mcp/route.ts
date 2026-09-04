import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { z } from 'zod';
import { supabaseFromToken, verifySupabaseToken } from '@/lib/mcp/supabaseFromToken';
import { buildServerInstructions } from '@/lib/ai/methodology/modules';
import {
  listBooks,
  listChapters,
  listSections,
  getWritingContext,
  getSectionDraft,
  getDevelopmentBriefing,
  searchManuscript,
  getProseSignals,
  applyParagraphRevision,
  previewSectionVersion,
  applySectionVersion,
  listSectionVersions,
  previewSectionRestore,
  applySectionRestore,
  previewChapterVersion,
  applyChapterVersion,
  listChapterVersions,
  previewChapterRestore,
  applyChapterRestore,
  previewManuscriptVersion,
  applyManuscriptVersion,
  listManuscriptVersions,
  previewManuscriptRestore,
  applyManuscriptRestore,
  runReview,
  runDeepReview,
  getDeepReviewContext,
  verifyAndPersistReviewCandidates,
  listReviewFindings,
  setReviewFindingStatus,
  proposeCanonFromFinding,
  getVoiceReport,
  type ToolResult
} from '@/lib/mcp/tools';

// Runs per-request as the signed-in user (RLS applies). Never static.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pull the verified Supabase access token out of the MCP request context. The
// token was validated in verifyToken (below) and surfaced on authInfo; here we
// turn it into a per-request, RLS-scoped Supabase client.
function supabaseFor(ctx: unknown) {
  const token = (ctx as { http?: { authInfo?: { token?: string } }; authInfo?: { token?: string } })?.http?.authInfo
    ?.token ?? (ctx as { authInfo?: { token?: string } })?.authInfo?.token;
  if (!token) throw new Error('Not authenticated');
  return supabaseFromToken(token);
}

const focusEnum = z.enum(['auto', 'threads', 'relationships', 'arc', 'dream', 'chapter_goal', 'story_health']);

const baseHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      'list_books',
      {
        title: 'List Books',
        description: "List the signed-in author's books (id, title, status). Start here to choose a book.",
        inputSchema: z.object({})
      },
      async (_args: Record<string, never>, ctx: unknown): Promise<ToolResult> => listBooks(supabaseFor(ctx))
    );

    server.registerTool(
      'list_chapters',
      {
        title: 'List Chapters',
        description: 'List the chapters of a book, in reading order.',
        inputSchema: z.object({ book_id: z.string().uuid() })
      },
      async (args: { book_id: string }, ctx: unknown): Promise<ToolResult> => listChapters(supabaseFor(ctx), args)
    );

    server.registerTool(
      'list_sections',
      {
        title: 'List Sections',
        description: 'List the writing sections of a chapter, with a short preview of each.',
        inputSchema: z.object({ chapter_id: z.string().uuid() })
      },
      async (args: { chapter_id: string }, ctx: unknown): Promise<ToolResult> => listSections(supabaseFor(ctx), args)
    );

    server.registerTool(
      'get_writing_context',
      {
        title: 'Get Writing Context',
        description:
          'Assemble the relevant, provenance-tagged writing context for a section (book, chapter, previous sections, characters/settings in scene, active threads, established canon). Deterministic; no AI call. Use before drafting.',
        inputSchema: z.object({ section_id: z.string().uuid() })
      },
      async (args: { section_id: string }, ctx: unknown): Promise<ToolResult> =>
        getWritingContext(supabaseFor(ctx), args)
    );

    server.registerTool(
      'get_section_draft',
      {
        title: 'Get Section Draft',
        description: 'Read the current saved draft of a section (content, word count, status).',
        inputSchema: z.object({ section_id: z.string().uuid() })
      },
      async (args: { section_id: string }, ctx: unknown): Promise<ToolResult> =>
        getSectionDraft(supabaseFor(ctx), args)
    );

    server.registerTool(
      'get_development_briefing',
      {
        title: 'Get Development Briefing',
        description:
          'Assemble the deterministic Story Context Model for development work: identity, arc/position, threads (with elapsed-chapter signals), relationships, character facts, information state, setup/payoff signals, purpose, dream/revelation, world rules, decisions, open questions, working notes — plus objective candidate items for attention and the methodology guidance to follow. Makes NO literary judgment and NO AI call; the host model supplies interpretation, the writer decides. `focus` biases which methodology modules are attached.',
        inputSchema: z.object({ section_id: z.string().uuid(), focus: focusEnum.optional() })
      },
      async (args: { section_id: string; focus?: z.infer<typeof focusEnum> }, ctx: unknown): Promise<ToolResult> =>
        getDevelopmentBriefing(supabaseFor(ctx), args)
    );

    server.registerTool(
      'search_manuscript',
      {
        title: 'Search Manuscript',
        description:
          'Story-wide prose EVIDENCE retrieval (distinct from get_writing_context, which is local to one section). Given OR-separated terms (e.g. "bee|swarm|honey", a character name, or a setup keyword), returns the chapters/sections containing them with a short excerpt around each first match. Use it to pull a relevant setup that may be many chapters earlier — following the `retrieval_plan` in get_development_briefing. Deterministic; supplies evidence, never interprets it.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          query: z.string().min(2),
          limit: z.number().int().min(1).max(20).optional(),
          near_chapter: z.number().int().min(1).optional()
        })
      },
      async (args: { book_id: string; query: string; limit?: number; near_chapter?: number }, ctx: unknown): Promise<ToolResult> =>
        searchManuscript(supabaseFor(ctx), args)
    );

    server.registerTool(
      'get_prose_signals',
      {
        title: 'Get Prose Signals',
        description:
          'Deterministic Prose & Voice Health / Targeted Revision foundation for a section: splits it into stable paragraph anchors and returns objective signals (emphatic-negation runs, motive pre-emption, insistence terms, filler phrases, fragment runs, repeated openers/terms) + per-paragraph stats (sentence length, adverb rate, dialogue ratio) + a runtime voice baseline (from other sections) with drift deltas. NO literary verdicts, NO AI-detection, NO LLM. The host interprets these into CRAFT / VOICE DRIFT / AUTHOR PREFERENCE and KEEP/TRIM/REWORK/CUT_CANDIDATE/MOVE, one finding at a time; the writer decides; nothing is rewritten or saved.',
        inputSchema: z.object({ section_id: z.string().uuid(), baseline_sample: z.number().int().min(2).max(20).optional() })
      },
      async (args: { section_id: string; baseline_sample?: number }, ctx: unknown): Promise<ToolResult> =>
        getProseSignals(supabaseFor(ctx), args)
    );

    server.registerTool(
      'apply_paragraph_revision',
      {
        title: 'Apply Paragraph Revision',
        description:
          'WRITE: persist ONE writer-approved paragraph replacement. Call ONLY after the writer explicitly approves a proposed revision (e.g. "use that", "yes", an Apply action) — never on "show me an alternative" or after merely displaying a suggestion. It performs no literary reasoning: it re-fetches the current section, recomputes anchors, verifies the target still matches (else returns TARGET_CHANGED / WRONG_ORIGINAL / AMBIGUOUS_TARGET and writes nothing), snapshots the pre-edit section into section_versions, then replaces exactly that one paragraph — nothing else in the section, chapter, or Story Canon. One approved passage at a time; no bulk edits.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          section_id: z.string().uuid(),
          chapter_id: z.string().uuid().optional(),
          passage_anchor: z.string().min(5),
          expected_original_text: z.string().optional(),
          approved_replacement_text: z.string().min(1),
          reason: z.string().optional(),
          classification: z.string().optional(),
          source: z.string().optional()
        })
      },
      async (
        args: { book_id: string; section_id: string; chapter_id?: string; passage_anchor: string; expected_original_text?: string; approved_replacement_text: string; reason?: string; classification?: string; source?: string },
        ctx: unknown
      ): Promise<ToolResult> => applyParagraphRevision(supabaseFor(ctx), args)
    );

    server.registerTool(
      'preview_section_version',
      {
        title: 'Preview Section Version',
        description:
          'READ-ONLY. Compare a proposed new full-section content against the current section: returns word counts before/after, a paragraph/line diff, change summary, relationship validation, and the current content hash + updated_at (the marker apply must match). A section upload is the COMPLETE new content for one section — it is NOT split on "~~~" and NOT mapped. Returns UNCHANGED if identical. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), section_id: z.string().uuid(), chapter_id: z.string().uuid().optional(), incoming_content: z.string() })
      },
      async (args: { book_id: string; section_id: string; chapter_id?: string; incoming_content: string }, ctx: unknown): Promise<ToolResult> =>
        previewSectionVersion(supabaseFor(ctx), args)
    );

    server.registerTool(
      'apply_section_version',
      {
        title: 'Apply Section Version',
        description:
          'WRITE: replace ONE section\'s content with a writer-approved new version. Call ONLY after explicit confirmation. Re-fetches the section, verifies the book/chapter relationship and that the current content still matches the previewed hash (else TARGET_CHANGED — never overwrite newer edits), snapshots the current version into section_versions (manual_snapshot), then replaces only that section\'s content + word_count. Nothing else — no other sections, chapter structure, sort order, or Story Canon.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          section_id: z.string().uuid(),
          chapter_id: z.string().uuid().optional(),
          expected_content_hash: z.string().min(1),
          expected_updated_at: z.string().optional(),
          approved_content: z.string().min(1)
        })
      },
      async (args: { book_id: string; section_id: string; chapter_id?: string; expected_content_hash: string; expected_updated_at?: string; approved_content: string }, ctx: unknown): Promise<ToolResult> =>
        applySectionVersion(supabaseFor(ctx), args)
    );

    server.registerTool(
      'list_section_versions',
      {
        title: 'List Section Versions',
        description:
          'READ-ONLY. Return the saved historical versions of ONE section (newest first) from section_versions — id, version_reason, created_at, word count, short excerpt — plus the live current-section word count, content hash, and updated_at. Scoped to the given section only; never crosses sections. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), section_id: z.string().uuid(), chapter_id: z.string().uuid().optional() })
      },
      async (args: { book_id: string; section_id: string; chapter_id?: string }, ctx: unknown): Promise<ToolResult> =>
        listSectionVersions(supabaseFor(ctx), args)
    );

    server.registerTool(
      'preview_section_restore',
      {
        title: 'Preview Section Restore',
        description:
          'READ-ONLY. Compare the current section (before) against a chosen historical version (after) by version_id: word counts, a paragraph/line diff, change summary, and the current content hash + updated_at (the marker restore must match). The version_id is re-verified to belong to this section. Returns UNCHANGED if identical. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), section_id: z.string().uuid(), chapter_id: z.string().uuid().optional(), version_id: z.string().uuid() })
      },
      async (args: { book_id: string; section_id: string; chapter_id?: string; version_id: string }, ctx: unknown): Promise<ToolResult> =>
        previewSectionRestore(supabaseFor(ctx), args)
    );

    server.registerTool(
      'apply_section_restore',
      {
        title: 'Apply Section Restore',
        description:
          'WRITE: replace ONE section\'s content with a historical version (by version_id). Call ONLY after explicit confirmation. Re-verifies the version belongs to the section, verifies the current content still matches the previewed hash (else TARGET_CHANGED — never overwrite newer edits), snapshots the CURRENT content into section_versions (manual_snapshot) FIRST, then replaces only that section\'s content + word_count. The restore is therefore itself reversible. Nothing else changes.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          section_id: z.string().uuid(),
          chapter_id: z.string().uuid().optional(),
          version_id: z.string().uuid(),
          expected_content_hash: z.string().min(1),
          expected_updated_at: z.string().optional()
        })
      },
      async (args: { book_id: string; section_id: string; chapter_id?: string; version_id: string; expected_content_hash: string; expected_updated_at?: string }, ctx: unknown): Promise<ToolResult> =>
        applySectionRestore(supabaseFor(ctx), args)
    );

    server.registerTool(
      'preview_chapter_version',
      {
        title: 'Preview Chapter Version',
        description:
          'READ-ONLY. Parse an uploaded chapter document into structured sections (using the "~~~" scene-break rule — never character splitting), match each against the current chapter by content identity (exact, else best line-overlap, not array position), and return the proposed plan: per-section status (unchanged / modified / added / missing-from-upload), diffs, word counts, proposed order, and a chapter_hash concurrency token. Sections missing from the upload are surfaced for preservation, never auto-deleted. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), chapter_id: z.string().uuid(), incoming_content: z.string() })
      },
      async (args: { book_id: string; chapter_id: string; incoming_content: string }, ctx: unknown): Promise<ToolResult> =>
        previewChapterVersion(supabaseFor(ctx), args)
    );

    server.registerTool(
      'apply_chapter_version',
      {
        title: 'Apply Chapter Version',
        description:
          'WRITE: atomically replace a chapter with a writer-approved uploaded version. Call ONLY after explicit confirmation. Verifies the chapter still matches the previewed chapter_hash (else TARGET_CHANGED — never overwrite newer edits), snapshots the WHOLE current chapter into chapter_versions, then applies approved section updates, new sections, explicit removals, and reordering in ONE transaction (a chapter can never end up half old / half new). Sections absent from the upload are preserved unless their id is passed in removals. Nothing outside this chapter is touched.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          chapter_id: z.string().uuid(),
          incoming_content: z.string().min(1),
          expected_chapter_hash: z.string().min(1),
          removals: z.array(z.string().uuid()).optional()
        })
      },
      async (args: { book_id: string; chapter_id: string; incoming_content: string; expected_chapter_hash: string; removals?: string[] }, ctx: unknown): Promise<ToolResult> =>
        applyChapterVersion(supabaseFor(ctx), args)
    );

    server.registerTool(
      'list_chapter_versions',
      {
        title: 'List Chapter Versions',
        description:
          'READ-ONLY. Return the saved chapter_versions of ONE chapter (newest first) — version_id, created_at, version_reason, chapter_title, section count, word count — plus the live current chapter word/section counts and its state hash. Scoped to the given chapter only. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), chapter_id: z.string().uuid() })
      },
      async (args: { book_id: string; chapter_id: string }, ctx: unknown): Promise<ToolResult> =>
        listChapterVersions(supabaseFor(ctx), args)
    );

    server.registerTool(
      'preview_chapter_restore',
      {
        title: 'Preview Chapter Restore',
        description:
          'READ-ONLY. Structurally compare the current chapter against a stored chapter version (by section identity): per-section status (unchanged / modified / only-in-current / only-in-selected), rename and reorder detection, per-section diffs, chapter word/section counts, and the current chapter_hash. version_id is re-verified to belong to this chapter. Returns UNCHANGED if identical. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), chapter_id: z.string().uuid(), version_id: z.string().uuid() })
      },
      async (args: { book_id: string; chapter_id: string; version_id: string }, ctx: unknown): Promise<ToolResult> =>
        previewChapterRestore(supabaseFor(ctx), args)
    );

    server.registerTool(
      'apply_chapter_restore',
      {
        title: 'Apply Chapter Restore',
        description:
          'WRITE: restore a chapter to a stored version (by version_id). Call ONLY after explicit confirmation. Verifies the chapter still matches the previewed chapter_hash (else TARGET_CHANGED), snapshots the WHOLE current chapter into chapter_versions (before_chapter_restore), then reconciles the live sections to EXACTLY the selected snapshot — update survivors, re-insert removed sections (original ids), delete sections not in the snapshot — in ONE transaction. Because the current chapter is snapshotted first, the restore is itself reversible. Nothing outside this chapter is touched.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          chapter_id: z.string().uuid(),
          version_id: z.string().uuid(),
          expected_chapter_hash: z.string().min(1)
        })
      },
      async (args: { book_id: string; chapter_id: string; version_id: string; expected_chapter_hash: string }, ctx: unknown): Promise<ToolResult> =>
        applyChapterRestore(supabaseFor(ctx), args)
    );

    server.registerTool(
      'preview_manuscript_version',
      {
        title: 'Preview Manuscript Version',
        description:
          'READ-ONLY. Parse an uploaded WHOLE manuscript (reusing the tuned "Chapter N: Title" + "~~~" rules) and compare it to the current book: chapter matching by identity (exact title, then content similarity — never array position), per-chapter status (unchanged/modified/new/needs-review/missing), section-level matching inside mapped chapters (reusing chapter-upload logic), chapter reorder, book/chapter/section/word counts, and the current manuscript_hash. Chapters absent from the upload are surfaced as kept, never auto-deleted. Ambiguous chapters are flagged needs-review. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), incoming_content: z.string() })
      },
      async (args: { book_id: string; incoming_content: string }, ctx: unknown): Promise<ToolResult> =>
        previewManuscriptVersion(supabaseFor(ctx), args)
    );

    server.registerTool(
      'apply_manuscript_version',
      {
        title: 'Apply Manuscript Version',
        description:
          'WRITE: activate a writer-approved manuscript version. Call ONLY after explicit confirmation and after all needs-review chapters are mapped. Verifies the current manuscript still matches the previewed hash (else TARGET_CHANGED), snapshots the WHOLE current manuscript into manuscript_snapshots, then applies chapter metadata/reorder, new chapters (+ sections), section updates/inserts/reorder, and EXPLICIT section removals in ONE transaction. KEEP-only: it NEVER deletes a chapter (chapters absent from the upload are preserved). Missing required mappings → NEEDS_RESOLUTION.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          incoming_content: z.string().min(1),
          expected_manuscript_hash: z.string().min(1),
          mappings: z.record(z.string(), z.string()).optional(),
          section_removals: z.array(z.string().uuid()).optional(),
          source: z.string().optional(),
          source_filename: z.string().optional()
        })
      },
      async (args: { book_id: string; incoming_content: string; expected_manuscript_hash: string; mappings?: Record<string, string>; section_removals?: string[]; source?: string; source_filename?: string }, ctx: unknown): Promise<ToolResult> =>
        applyManuscriptVersion(supabaseFor(ctx), args)
    );

    server.registerTool(
      'list_manuscript_versions',
      {
        title: 'List Manuscript Versions',
        description:
          'READ-ONLY. Return the saved whole-book versions of ONE book (newest first) from manuscript_snapshots — id, created_at, reason, source/filename, chapter/section/word counts — plus the live current book counts and manuscript hash. Scoped to the given book. Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid() })
      },
      async (args: { book_id: string }, ctx: unknown): Promise<ToolResult> =>
        listManuscriptVersions(supabaseFor(ctx), args)
    );

    server.registerTool(
      'preview_manuscript_restore',
      {
        title: 'Preview Manuscript Restore',
        description:
          'READ-ONLY. Structurally compare the current manuscript against a stored whole-book snapshot (by chapter_id/section_id identity): per-chapter status (unchanged/modified/only-in-current/only-in-selected) with rename + reorder, section-level diffs inside changed chapters, book/chapter/section/word counts, current manuscript_hash, can_restore, and blocking issues. KEEP-only: chapters added after the snapshot are surfaced as kept (never removed). Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid(), snapshot_id: z.string().uuid() })
      },
      async (args: { book_id: string; snapshot_id: string }, ctx: unknown): Promise<ToolResult> =>
        previewManuscriptRestore(supabaseFor(ctx), args)
    );

    server.registerTool(
      'apply_manuscript_restore',
      {
        title: 'Apply Manuscript Restore',
        description:
          'WRITE: restore the book to a stored whole-book snapshot. Call ONLY after explicit confirmation. Verifies the manuscript still matches the previewed hash (else TARGET_CHANGED), snapshots the WHOLE current manuscript (before_manuscript_restore), then reconciles each snapshot chapter (metadata + sections, 0007-safe) in ONE transaction. KEEP-only: chapters added after the snapshot are preserved, never deleted; if a snapshot chapter no longer exists it returns CHAPTER_REACTIVATION_REQUIRED and writes nothing. Reversible (current snapshotted first).',
        inputSchema: z.object({ book_id: z.string().uuid(), snapshot_id: z.string().uuid(), expected_manuscript_hash: z.string().min(1) })
      },
      async (args: { book_id: string; snapshot_id: string; expected_manuscript_hash: string }, ctx: unknown): Promise<ToolResult> =>
        applyManuscriptRestore(supabaseFor(ctx), args)
    );

    server.registerTool(
      'run_review',
      {
        title: 'Run Review & Continuity',
        description:
          'Story-consistency review over the ACTIVE manuscript (never removed chapters). Deterministic + evidence-first: emits candidate findings (unresolved storylines, setup/payoff, canon/character conflicts, timeline order, repeated passages, unresolved relationship tension), each citing a real chapter/section — never a verdict, never edits prose or canon. Reconciles with prior findings by fingerprint so writer states (intentional/resolved/watch) persist; a resolved finding reopens only if its evidence materially changed. Optional chapter_id scopes to one chapter. Writes only to review_findings.',
        inputSchema: z.object({ book_id: z.string().uuid(), chapter_id: z.string().uuid().optional() })
      },
      async (args: { book_id: string; chapter_id?: string }, ctx: unknown): Promise<ToolResult> =>
        runReview(supabaseFor(ctx), args)
    );

    server.registerTool(
      'get_voice_report',
      {
        title: 'Voice Consistency (whole manuscript)',
        description:
          'READ-ONLY, deterministic (no OpenAI). Builds a book-wide voice profile from every ACTIVE section (sentence length, -ly adverb rate, dialogue vs narration, short fragments, very long sentences) and returns the sections that read most differently from the rest — each as a statistical outlier with the specific metrics that differ and by how much, framed as a question for the writer. Never claims prose is bad or AI-written; reports measured differences only. Persists nothing; touches no prose or canon.',
        inputSchema: z.object({ book_id: z.string().uuid() })
      },
      async (args: { book_id: string }, ctx: unknown): Promise<ToolResult> =>
        getVoiceReport(supabaseFor(ctx), args)
    );

    server.registerTool(
      'list_review_findings',
      {
        title: 'List Review Findings',
        description: 'READ-ONLY. Current Review & Continuity findings for a book plus an attention summary (open/watch counts by level and type; resolved/intentional excluded from the attention count). Mutates nothing.',
        inputSchema: z.object({ book_id: z.string().uuid() })
      },
      async (args: { book_id: string }, ctx: unknown): Promise<ToolResult> =>
        listReviewFindings(supabaseFor(ctx), args)
    );

    server.registerTool(
      'set_review_finding_status',
      {
        title: 'Set Review Finding Status',
        description: "WRITE (review_findings only): set a finding's writer-managed state — 'open' (Needs Review), 'intentional', 'resolved', or 'watch' (Keep Watching). Does NOT touch manuscript prose or canon.",
        inputSchema: z.object({ book_id: z.string().uuid(), finding_id: z.string().uuid(), status: z.enum(['open', 'intentional', 'resolved', 'watch']) })
      },
      async (args: { book_id: string; finding_id: string; status: 'open' | 'intentional' | 'resolved' | 'watch' }, ctx: unknown): Promise<ToolResult> =>
        setReviewFindingStatus(supabaseFor(ctx), args)
    );

    server.registerTool(
      'run_deep_review',
      {
        title: 'Run Deep (AI) Review — direct provider (uses OpenAI)',
        description:
          "STANDALONE path: this makes a DIRECT OpenAI call on Book Build's own API key (billed to the account and counted against its cost caps) to generate candidates, then evidence-verifies and persists them. If you are an MCP host (Claude/ChatGPT) you can do the reasoning yourself for FREE instead: call get_deep_review_context, generate candidates, then verify_and_persist_review_candidates — same verification and results, no OpenAI cost. Behavior otherwise: proposes subtle continuity candidates from a bounded digest of the ACTIVE manuscript, EVIDENCE-VERIFIES each against real section text and DISCARDS anything unsupported, dedupes vs deterministic, reconciles through review_findings (writer states persist), hash-gated to avoid needless re-calls; provider failure leaves deterministic findings intact. Writes only review_findings / review_ai_runs — never prose or canon.",
        inputSchema: z.object({ book_id: z.string().uuid(), chapter_id: z.string().uuid().optional() })
      },
      async (args: { book_id: string; chapter_id?: string }, ctx: unknown): Promise<ToolResult> =>
        runDeepReview(supabaseFor(ctx), args)
    );

    server.registerTool(
      'get_deep_review_context',
      {
        title: 'Get Deep Review Context (host-mode, no OpenAI)',
        description:
          'HOST-MODE step 1 of 2 (no OpenAI call). Returns everything YOU (the MCP host) need to generate continuity-review candidates yourself: the deterministic review summary + findings already found (do not restate them), a bounded per-chapter manuscript digest, story-state context, the exact candidate_schema to return, the review methodology/instructions, max_candidates, and the manuscript_hash. Read-only — assembles context, persists nothing, never touches prose or canon. Generate at most max_candidates candidates (each quoting the digest verbatim as evidence), then call verify_and_persist_review_candidates with the returned manuscript_hash.',
        inputSchema: z.object({ book_id: z.string().uuid(), chapter_id: z.string().uuid().optional() })
      },
      async (args: { book_id: string; chapter_id?: string }, ctx: unknown): Promise<ToolResult> =>
        getDeepReviewContext(supabaseFor(ctx), args)
    );

    server.registerTool(
      'verify_and_persist_review_candidates',
      {
        title: 'Verify & Persist Review Candidates (host-mode, no OpenAI)',
        description:
          'HOST-MODE step 2 of 2 (no OpenAI call). Takes YOUR host-generated candidates (from get_deep_review_context) and runs the SAME deterministic pipeline used for provider candidates: verifies ownership/RLS, rejects the call if the manuscript changed since context was fetched (REVIEW_CONTEXT_CHANGED), locates every candidate quote in the CURRENT active manuscript and DISCARDS anything unsupported (host input is untrusted; fabricated quotes are dropped), dedupes vs deterministic findings, reconciles into review_findings (writer states — resolved/intentional/watch — persist), and records the run as source mcp_host. Returns the verified findings plus a discarded-candidate summary. Bounded candidate count; never calls OpenAI; never writes prose or canon.',
        inputSchema: z.object({
          book_id: z.string().uuid(),
          scope: z.string().optional(),
          expected_manuscript_hash: z.string().min(1),
          candidates: z.array(z.object({
            type: z.string(),
            title: z.string(),
            claim: z.string().optional(),
            explanation: z.string(),
            involved_entities: z.array(z.object({ kind: z.string(), name: z.string() })).optional(),
            evidence_targets: z.array(z.object({ chapter_hint: z.union([z.string(), z.number()]).optional(), quote_or_terms: z.string() })).min(1),
            question_for_writer: z.string().optional(),
            confidence: z.number().optional(),
            reasoning_category: z.string().optional(),
            claim_basis: z.enum(['positive_conflict', 'absence_based', 'progression_gap', 'open_question']).optional(),
            level_hint: z.enum(['worth_checking', 'likely_conflict']).optional()
          })).min(1).max(50)
        })
      },
      async (args: { book_id: string; scope?: string; expected_manuscript_hash: string; candidates: unknown }, ctx: unknown): Promise<ToolResult> =>
        verifyAndPersistReviewCandidates(supabaseFor(ctx), args)
    );

    server.registerTool(
      'propose_canon_from_finding',
      {
        title: 'Propose Canon From Finding',
        description: 'Create a PENDING Story-Canon proposal (story_bible_proposals, proposal_type canon_fact) from a review finding + a writer-edited fact. Does NOT write canon — the writer approves it in the existing Story Canon approval flow.',
        inputSchema: z.object({ book_id: z.string().uuid(), finding_id: z.string().uuid(), fact: z.string().min(1) })
      },
      async (args: { book_id: string; finding_id: string; fact: string }, ctx: unknown): Promise<ToolResult> =>
        proposeCanonFromFinding(supabaseFor(ctx), args)
    );
  },
  {
    serverInfo: { name: 'book-build', version: '0.1.0-poc' },
    // Always-on methodology (master rules + development/suggestion modes +
    // drafting gate). Situational playbooks are attached per-briefing.
    instructions: buildServerInstructions()
  }
);

// Bearer auth: the token must be a valid Supabase session access token. We
// verify it against Supabase (existing identity) and, when valid, surface it on
// authInfo so each tool can build an RLS-scoped client. Read-only POC — no
// write tools are registered above.
const handler = withMcpAuth(
  baseHandler,
  async (_req: Request, bearerToken?: string) => {
    if (!bearerToken) return undefined;
    const res = await verifySupabaseToken(bearerToken);
    if (!res) return undefined;
    return { token: bearerToken, clientId: res.userId, scopes: [], extra: { userId: res.userId } };
  },
  { required: true }
);

export { handler as GET, handler as POST };
