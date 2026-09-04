// Hand-written types matching supabase/migrations/0001_init.sql,
// 0002_canon_scenes_imports.sql, 0004_plan.sql, and 0003_manuscript_versions.sql
// (Version History — applied when that feature was built).
// Once the project is live, regenerate the authoritative version with:
//   supabase gen types typescript --project-id <ref> > src/lib/types/database.ts
// (or the Supabase MCP `generate_typescript_types` tool) and diff it against
// this file — hand edits below should survive that diff untouched.

export type BookStatus = 'Planning' | 'Drafting' | 'Revising' | 'Completed';
export type ChapterStatus = 'Not Started' | 'Drafting' | 'Needs Review' | 'Reviewed' | 'Complete';
export type SectionStatus = 'Draft' | 'Needs Attention' | 'Reviewed' | 'Complete';
export type ThreadStatus = 'Active' | 'Dormant' | 'Resolved' | 'Planned Later';
export type SuggestionLevel = 'light' | 'guided' | 'deep';
export type WorkingNoteType = 'thought' | 'idea' | 'note' | 'draft';
export type WorkingNoteStatus = 'active' | 'archived';

// Why a manuscript version exists (migration 0003). 'manual_snapshot' and
// 'milestone' are author-initiated; the before_* reasons are created
// automatically by the system immediately before an operation that could
// affect many chapters at once, so the prior state is always one version away.
export type ManuscriptVersionReason =
  | 'manual_snapshot'
  | 'before_restore'
  | 'before_book_revision'
  | 'before_import_merge'
  | 'milestone';

// --- Three independent canon axes (migration 0002) -------------------------
// These are NOT stages of one lifecycle. A fact can be author_canon AND
// confirmed_in_manuscript at the same time; marking it confirmed in the
// manuscript must never overwrite or imply anything about canon_status.
export type CanonStatus = 'working_note' | 'author_canon';
export type CanonSourceType = 'interview_answer' | 'before_you_continue' | 'manual' | 'ai_inference' | 'manuscript_detected';
export type ManuscriptStatus = 'not_checked' | 'proposed_match' | 'confirmed_in_manuscript' | 'contradicted';
export type ReaderKnowledge = 'reader_knows' | 'reader_suspects' | 'intentionally_hidden' | 'not_yet_introduced' | 'should_know_by_now';

// Shared by canon_facts and timeline_events. Defaults to 'unclassified' —
// never defaults to 'physical_event'. A physical event or narrator-confirmed
// fact must be deliberately established, not assumed on import.
export type RealityLayer =
  | 'unclassified'
  | 'physical_event'
  | 'dream'
  | 'vision'
  | 'supernatural_perception'
  | 'internal_thought'
  | 'memory'
  | 'prophecy_revelation'
  | 'character_interpretation'
  | 'narrator_confirmed_fact';

export type AiCheckState = 'idle' | 'queued' | 'running';
export type ConflictResolution = 'pending' | 'keep_original' | 'update_canon' | 'temporary' | 'not_conflict';
export type NextExpectedBeat = 'soon' | 'current_arc' | 'later_in_book' | 'sequel' | 'no_planned_timing' | 'custom';
export type ImportProcessingState = 'uploaded' | 'parsing' | 'chapters_detected' | 'chapters_confirmed' | 'analyzing' | 'complete' | 'failed';
export type ImportChapterAnalysisState = 'pending' | 'running' | 'complete' | 'failed';
export type StoryBibleProposalType = 'character' | 'setting' | 'relationship' | 'story_thread' | 'timeline_event' | 'canon_fact';
export type StoryBibleProposalStatus = 'pending' | 'approved' | 'edited' | 'rejected';

// --- PLAN (migration 0004) --------------------------------------------------
// Layer boundary, enforced by construction, not just convention:
//   STORY CANON (characters/settings/canon_facts/etc.) = what is true
//   OUTLINE (StoryOutline / ChapterOutline / OutlineBeat below)   = what is planned
//   MANUSCRIPT (Chapter / WritingSection above)                  = what has been written
// Nothing here ever becomes a CanonFact merely because it was planned.
export type OutlineStructureType =
  | 'three_act'
  | 'four_act'
  | 'heros_journey'
  | 'save_the_cat'
  | 'mystery'
  | 'romance'
  | 'custom'
  | 'unstructured';
export type OutlineNodeType = 'act' | 'chapter' | 'scene_or_beat';

export type Book = {
  id: string;
  user_id: string;
  title: string;
  subtitle: string | null;
  genre: string | null;
  target_audience: string | null;
  pov: string | null;
  tense: string | null;
  description: string | null;
  author_notes: string | null;
  status: BookStatus;
  ai_suggestion_level: SuggestionLevel;
  ai_toggles: {
    ask_before_prose: boolean;
    continuity_warnings: boolean;
    thread_reminders: boolean;
    description_reminders: boolean;
    reaction_reminders: boolean;
  };
  writing_unit_pref: 'paragraph' | 'page' | 'scene_section' | 'full_scene';
  created_at: string;
  updated_at: string;
};

export type Chapter = {
  id: string;
  book_id: string;
  chapter_number: number | null;
  title: string;
  summary: string | null;
  status: ChapterStatus;
  sort_order: number;
  // Manuscript membership (migration 0010): null = ACTIVE in the manuscript;
  // set = removed from the active manuscript but preserved (reversible). Never
  // deleted. Current-manuscript reads filter archived_at is null.
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

// A Scene is optional. A Section may reference at most one Scene — this is
// enforced by writing_sections.scene_id being a plain scalar FK, not a join
// table, so a Section cannot cross a scene boundary in Phase 1.
export type Scene = {
  id: string;
  chapter_id: string;
  title: string | null;
  pov_character_id: string | null;
  setting_id: string | null;
  time_context: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type WritingSection = {
  id: string;
  chapter_id: string;
  scene_id: string | null;
  sort_order: number;
  title: string | null;
  content: string;
  summary: string | null;
  status: SectionStatus;
  word_count: number;
  pre_writing_answers: PreWritingAnswer[];
  // Continuity-check plumbing: a cheap skip guard (content_hash vs.
  // last_ai_check_content_hash) plus a concurrency guard (ai_check_state),
  // so AI analysis never runs on unchanged content or twice at once. The
  // 150-word / 90-second thresholds are enforced in app code against these
  // columns, not in the database.
  content_hash: string | null;
  last_ai_check_at: string | null;
  last_ai_check_content_hash: string | null;
  last_ai_checked_word_count: number;
  ai_check_state: AiCheckState;
  created_at: string;
  updated_at: string;
};

// Working Notes (migration 0017) — private, loose, explicitly non-canonical
// material. These rows are never manuscript prose and never Story Canon unless
// a later, explicit writer action copies/promotes text elsewhere.
export type WorkingNote = {
  id: string;
  book_id: string;
  user_id: string;
  title: string;
  content: string;
  note_type: WorkingNoteType;
  status: WorkingNoteStatus;
  chapter_id: string | null;
  section_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PreWritingAnswer = {
  question: string;
  answer: string;
  basedOn: string[];
};

export type SectionVersion = {
  id: string;
  // Nullable since migration 0007: when a section is removed, its history rows
  // DETACH (section_id → null) instead of cascade-deleting, and reconnect if the
  // same section id is re-created (e.g. chapter restore). detached_* remember
  // where a detached row came from so it reconnects only within the same book.
  section_id: string | null;
  content: string;
  version_reason: 'manual_snapshot' | 'before_fix_with_me' | 'before_ai_edit' | 'before_continuity_correction' | 'before_chapter_revision';
  detached_section_id: string | null;
  detached_book_id: string | null;
  created_at: string;
};

export type Character = {
  id: string;
  book_id: string;
  name: string;
  role: string | null;
  age: string | null;
  appearance: string | null;
  personality: string | null;
  background: string | null;
  goals: string | null;
  fears: string | null;
  beliefs: string | null;
  voice_notes: string | null;
  author_notes: string | null;
  details: Record<string, unknown>;
  first_appearance_chapter: string | null;
  created_at: string;
  updated_at: string;
};

export type SettingProfile = {
  id: string;
  book_id: string;
  name: string;
  setting_type: string | null;
  description: string | null;
  layout: string | null;
  lighting: string | null;
  sounds: string | null;
  smells: string | null;
  sensory_details: string | null;
  atmosphere: string | null;
  important_objects: string | null;
  canon_notes: string | null;
  first_appearance_chapter: string | null;
  created_at: string;
  updated_at: string;
};

export type Relationship = {
  id: string;
  book_id: string;
  character_a_id: string;
  character_b_id: string;
  relationship_type: string | null;
  current_status: string | null;
  history: string | null;
  unresolved_tension: string | null;
  last_meaningful_interaction: string | null;
  notes: string | null;
  updated_at: string;
};

export type StoryThread = {
  id: string;
  book_id: string;
  title: string;
  description: string | null;
  status: ThreadStatus;
  first_chapter_id: string | null;
  last_chapter_id: string | null;
  planned_payoff: string | null;
  author_notes: string | null;
  // What the reader should expect next, and when — so a deliberately parked
  // thread (sequel material, "later in book") doesn't trigger a dormant-
  // thread nudge it was never supposed to get.
  next_expected_beat: NextExpectedBeat | null;
  next_expected_beat_note: string | null;
  created_at: string;
  updated_at: string;
};

export type CanonFact = {
  id: string;
  book_id: string;
  fact_type: string;
  subject_type: 'character' | 'setting' | 'relationship' | 'story_thread' | 'book' | 'general';
  subject_id: string | null;
  fact: string;
  source_type: CanonSourceType;
  source_id: string | null;
  // Three independent axes — see the CanonStatus/ManuscriptStatus/
  // RealityLayer comment above. Never treat these as one lifecycle.
  canon_status: CanonStatus;
  manuscript_status: ManuscriptStatus;
  reader_knowledge: ReaderKnowledge | null;
  reality_layer: RealityLayer;
  created_at: string;
  updated_at: string;
};

// Durable restoration history for the "contradicted" manuscript_status.
// previous_manuscript_status + previous_fact_text are snapshotted the
// moment a conflict is raised, so resolving it (Keep Original / It's
// Temporary / Not a Conflict) never depends on application memory.
// resolution_note carries the short rationale for that decision — this is
// where "manuscript_status_note"-style context lives, scoped per conflict
// rather than a single mutable field on canon_facts.
export type CanonFactConflict = {
  id: string;
  canon_fact_id: string;
  section_id: string | null;
  previous_manuscript_status: 'not_checked' | 'proposed_match' | 'confirmed_in_manuscript';
  previous_fact_text: string;
  conflicting_excerpt: string;
  description: string | null;
  resolution: ConflictResolution;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type TimelineEvent = {
  id: string;
  book_id: string;
  chapter_id: string | null;
  section_id: string | null;
  event_order: number;
  date_text: string | null;
  time_text: string | null;
  relative_time: string | null;
  event_description: string;
  characters_present: string[];
  reality_layer: RealityLayer;
  created_at: string;
  updated_at: string;
};

export type AiInterview = {
  id: string;
  book_id: string;
  chapter_id: string | null;
  section_id: string | null;
  working_note_id: string | null;
  interview_type: 'development' | 'setting' | 'character' | 'continuity_fix' | 'continue' | 'plan_new_book' | 'plan_chapter';
  topic: string | null;
  status: 'in_progress' | 'complete' | 'abandoned';
  development_notes: DevelopmentNotes | null;
  // PLAN only — which outline this interview is building toward. Both null
  // for every other interview_type.
  story_outline_id: string | null;
  chapter_outline_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DevelopmentNotes = {
  location?: string;
  people_present?: string[];
  emotional_state?: string;
  scene_objective?: string;
  conflict?: string;
  revelations?: string[];
  possible_ending?: string;
  continuity_considerations?: string[];
};

export type AiInterviewMessage = {
  id: string;
  interview_id: string;
  role: 'assistant' | 'author';
  content: string;
  created_at: string;
};

export type StoryThreadCharacter = {
  story_thread_id: string;
  character_id: string;
};

export type SectionReview = {
  id: string;
  section_id: string;
  overall_summary: string | null;
  review_status: 'clear' | 'issues_found';
  created_at: string;
};

export type ReviewIssue = {
  id: string;
  review_id: string;
  issue_type: string;
  severity: 'critical' | 'should_address' | 'optional';
  description: string;
  quoted_context: string | null;
  suggested_action: string | null;
  status: 'open' | 'resolved' | 'ignored';
  created_at: string;
  updated_at: string;
};

// The uploaded .docx itself lives in Supabase Storage; this row is only the
// pointer, metadata, hash, owner, and processing state.
export type ManuscriptImport = {
  id: string;
  book_id: string;
  owner_user_id: string;
  storage_bucket: string;
  storage_path: string;
  original_filename: string;
  file_size_bytes: number | null;
  file_hash: string;
  mime_type: string | null;
  processing_state: ImportProcessingState;
  created_at: string;
  updated_at: string;
};

// One row per detected chapter boundary. sections_materialized and
// analysis_state are tracked as two separate, independently-checkable
// steps, so a retried import job can resume from wherever it actually left
// off instead of redoing already-materialized chapters.
export type ImportChapter = {
  id: string;
  import_id: string;
  sequence_index: number;
  detected_title: string | null;
  source_char_start: number;
  source_char_end: number;
  chapter_id: string | null;
  sections_materialized: boolean;
  analysis_state: ImportChapterAnalysisState;
  created_at: string;
  updated_at: string;
};

// AI-extracted Story Canon candidates, pending author approval. These must
// never become real characters/settings/canon_facts/etc. on their own —
// only an explicit author approval creates the real record and back-fills
// approved_record_table/approved_record_id here.
// (Type name and the underlying story_bible_proposals table are left as-is —
// they're already-applied live schema, not user-facing terminology.)
export type StoryBibleProposal = {
  id: string;
  book_id: string;
  import_id: string | null;
  chapter_id: string | null;
  section_id: string | null;
  proposal_type: StoryBibleProposalType;
  payload: Record<string, unknown>;
  supporting_excerpt: string | null;
  source_char_start: number | null;
  source_char_end: number | null;
  dedupe_key: string;
  status: StoryBibleProposalStatus;
  approved_record_table: string | null;
  approved_record_id: string | null;
  created_at: string;
  updated_at: string;
};

// story_outlines — the book-level plan: Book Arc → Act → Chapter →
// Scene/Beat, via the self-referencing node tree (StoryOutlineNode) below.
// Versioned via version_number + is_current, same pattern as
// ChapterOutline — an old version's nodes are simply never updated again
// once a newer version exists.
export type StoryOutline = {
  id: string;
  book_id: string;
  structure_type: OutlineStructureType;
  structure_type_note: string | null;
  version_number: number;
  is_current: boolean;
  note: string | null;
  created_by: string;
  created_at: string;
};

export type StoryOutlineNode = {
  id: string;
  story_outline_id: string;
  parent_node_id: string | null;
  node_type: OutlineNodeType;
  // Set once "Start Writing" materializes a real chapter for this node.
  // Planning usually happens before the chapter exists, so this starts null.
  chapter_id: string | null;
  title: string;
  purpose: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

// chapter_outlines — the deep, one-chapter plan ("Plan This Chapter" /
// "Detailed Chapter Outline"). Distinct from a StoryOutlineNode's one-line
// purpose — this is what the chapter-planning interview actually produces.
export type ChapterOutline = {
  id: string;
  chapter_id: string;
  version_number: number;
  is_current: boolean;
  purpose: string | null;
  opening_state: string | null;
  chapter_end_state: string | null;
  new_questions_created: string | null;
  continuity_notes: string | null;
  created_by: string;
  created_at: string;
};

export type ChapterOutlineScene = {
  id: string;
  chapter_outline_id: string;
  title: string;
  goal: string | null;
  setting_id: string | null;
  sort_order: number;
};

// outline_beats — Beat-by-Beat. A small movement, not necessarily a full
// scene; freely reorderable (Move Up / Move Down in the UI, never
// drag-and-drop — mobile requirement).
export type OutlineBeat = {
  id: string;
  chapter_outline_scene_id: string;
  text: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Database type — matches @supabase/postgrest-js's GenericSchema contract:
// every table needs Row/Insert/Update/Relationships, and the schema needs
// Tables/Views/Functions, or `createBrowserClient<Database>` fails to unify
// with SupabaseClient's generics (the bug this shape fixes). `Profile` has
// no exported interface elsewhere in this file, so it's inlined once here.
//
// Insert types are Partial<Row> plus the columns that have neither a default
// nor a nullable type in the migrations — i.e. what Postgres actually
// requires on INSERT. Update types are Partial<Row> everywhere; Postgres
// enforces the real constraints regardless of what TypeScript allows through.
// ---------------------------------------------------------------------------

// manuscript_versions — one row per deliberate, whole-book checkpoint
// (migration 0003). NOT autosave and NOT section_versions: this is the
// "Save Version" / before_* snapshot layer. word_count/chapter_count are
// captured at snapshot time so the list renders without joining the section
// snapshot table. name/description are editable (Rename / Add Note); content
// is not — immutability is enforced on ManuscriptVersionSection below.
export type ManuscriptVersion = {
  id: string;
  book_id: string;
  name: string;
  description: string | null;
  version_number: number;
  reason: ManuscriptVersionReason;
  word_count: number;
  chapter_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

// manuscript_version_sections — the snapshotted content, one row per section,
// enough to reconstruct Book → Chapters → Sections as they existed at save
// time. chapter_number/chapter_title are denormalized so the structural diff
// (chapter added/removed/renamed) needs no second snapshot table.
// source_section_id is ON DELETE SET NULL: the snapshot text must outlive the
// live section it came from. Rows are immutable once written (DB trigger).
export type ManuscriptVersionSection = {
  id: string;
  manuscript_version_id: string;
  source_section_id: string | null;
  chapter_number: number | null;
  chapter_title: string;
  scene_title: string | null;
  section_order: number;
  content: string;
  word_count: number;
};

// chapter_versions (migration 0005) — one row snapshots a WHOLE chapter before
// a Chapter Upload replaces it: chapter metadata + every section's identity,
// order, title, and content, as a recoverable jsonb manifest. Backs the (later)
// Chapter Version History + Restore. Written only by the apply_chapter_version
// RPC, which snapshots the current chapter inside the same transaction as the
// apply, so a chapter can never change without its prior state persisted.
export type ChapterSnapshotSection = {
  section_id: string;
  sort_order: number;
  title: string | null;
  content: string;
  word_count: number;
};
export type ChapterSnapshot = {
  chapter_id: string;
  chapter_title: string;
  chapter_number: number | null;
  captured_hash: string;
  sections: ChapterSnapshotSection[];
};
export type ChapterVersion = {
  id: string;
  chapter_id: string;
  book_id: string;
  version_reason: 'before_chapter_upload' | 'manual_snapshot' | 'before_chapter_restore';
  chapter_title: string | null;
  chapter_hash: string | null;
  snapshot: ChapterSnapshot;
  created_at: string;
};

// manuscript_snapshots (migration 0008) — whole-book version store for Upload
// New Manuscript Version. One row = one checkpoint, a jsonb snapshot preserving
// chapter_id/section_id identity + order + titles + content (consistent with
// chapter_versions). Distinct from the dormant, unapplied 0003 manuscript_versions.
export type ManuscriptSnapshotSection = { section_id: string; sort_order: number; title: string | null; content: string; word_count: number };
export type ManuscriptSnapshotChapter = { chapter_id: string; chapter_number: number | null; title: string; sort_order: number; sections: ManuscriptSnapshotSection[] };
export type ManuscriptSnapshotDoc = { book_id: string; book_title: string; manuscript_hash: string; chapters: ManuscriptSnapshotChapter[] };
export type ManuscriptSnapshot = {
  id: string;
  book_id: string;
  version_reason: 'before_manuscript_upload' | 'manual_snapshot' | 'before_manuscript_restore';
  source: string | null;
  source_filename: string | null;
  book_title: string | null;
  manuscript_hash: string | null;
  chapter_count: number;
  section_count: number;
  word_count: number;
  snapshot: ManuscriptSnapshotDoc;
  created_at: string;
};

// review_findings (migration 0012) — Review & Continuity results. Evidence-first,
// writer-managed states, reconciled on re-run by `fingerprint` (identity) +
// `evidence_hash` (material change). FIND/EXPLAIN/DECIDE — never edits prose/canon.
export type ReviewFindingType = 'continuity' | 'plot_thread' | 'character' | 'relationship' | 'timeline' | 'setup_payoff' | 'repetition' | 'knowledge' | 'naming' | 'writer_question';
export type ReviewFindingLevel = 'worth_checking' | 'likely_conflict' | 'open_question';
export type ReviewFindingStatus = 'open' | 'intentional' | 'resolved' | 'watch';
export type ReviewEvidenceRef = { chapter_id: string | null; chapter_number: number | null; section_id?: string | null; context: string };
export type ReviewEntityRef = { kind: string; id?: string | null; name: string };
export type ReviewFinding = {
  id: string;
  book_id: string;
  chapter_id: string | null;
  finding_type: ReviewFindingType;
  level: ReviewFindingLevel;
  status: ReviewFindingStatus;
  title: string;
  explanation: string;
  question: string | null;
  evidence: ReviewEvidenceRef[];
  entities: ReviewEntityRef[];
  confidence: number | null;
  fingerprint: string;
  evidence_hash: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

// review_ai_runs (migration 0013; source added 0016) — hash gate for the optional
// AI (Deep) review. `source` records the last provider: 'openai' | 'mcp_host'.
export type ReviewAiRun = { id: string; book_id: string; scope: string; manuscript_hash: string; source: string | null; created_at: string };

// ai_usage_log (migration 0014) — metadata-only cost/usage log for DIRECT
// OpenAI calls. No prompt/manuscript/output text is ever stored here.
export type AiUsageLog = {
  id: string;
  user_id: string;
  book_id: string | null;
  feature: string;
  model: string;
  status: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  unknown_pricing: boolean;
  request_id: string | null;
  duration_ms: number | null;
  error_category: string | null;
  created_at: string;
};

type TableDef<Row, RequiredInsert extends keyof Row = never> = {
  Row: Row;
  Insert: Partial<Row> & Pick<Row, RequiredInsert>;
  Update: Partial<Row>;
  Relationships: [];
};

type Profile = {
  id: string;
  display_name: string | null;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<Profile, 'id'>;
      books: TableDef<Book, 'user_id' | 'title'>;
      chapters: TableDef<Chapter, 'book_id'>;
      scenes: TableDef<Scene, 'chapter_id'>;
      writing_sections: TableDef<WritingSection, 'chapter_id'>;
      working_notes: TableDef<WorkingNote, 'book_id'>;
      section_versions: TableDef<SectionVersion, 'section_id' | 'content'>;
      chapter_versions: TableDef<ChapterVersion, 'chapter_id' | 'book_id' | 'snapshot'>;
      manuscript_snapshots: TableDef<ManuscriptSnapshot, 'book_id' | 'snapshot'>;
      review_findings: TableDef<ReviewFinding, 'book_id' | 'finding_type' | 'level' | 'title' | 'explanation' | 'fingerprint'>;
      review_ai_runs: TableDef<ReviewAiRun, 'book_id' | 'scope' | 'manuscript_hash'>;
      ai_usage_log: TableDef<AiUsageLog, 'user_id' | 'feature' | 'model' | 'status'>;
      characters: TableDef<Character, 'book_id' | 'name'>;
      settings: TableDef<SettingProfile, 'book_id' | 'name'>;
      relationships: TableDef<Relationship, 'book_id' | 'character_a_id' | 'character_b_id'>;
      story_threads: TableDef<StoryThread, 'book_id' | 'title'>;
      story_thread_characters: TableDef<StoryThreadCharacter, 'story_thread_id' | 'character_id'>;
      canon_facts: TableDef<CanonFact, 'book_id' | 'fact_type' | 'subject_type' | 'fact' | 'source_type'>;
      canon_fact_conflicts: TableDef<CanonFactConflict, 'canon_fact_id' | 'previous_manuscript_status' | 'previous_fact_text' | 'conflicting_excerpt'>;
      timeline_events: TableDef<TimelineEvent, 'book_id' | 'event_description'>;
      ai_interviews: TableDef<AiInterview, 'book_id' | 'interview_type'>;
      ai_interview_messages: TableDef<AiInterviewMessage, 'interview_id' | 'role' | 'content'>;
      section_reviews: TableDef<SectionReview, 'section_id'>;
      review_issues: TableDef<ReviewIssue, 'review_id' | 'issue_type' | 'severity' | 'description'>;
      manuscript_imports: TableDef<ManuscriptImport, 'book_id' | 'owner_user_id' | 'storage_path' | 'original_filename' | 'file_hash'>;
      import_chapters: TableDef<ImportChapter, 'import_id' | 'sequence_index' | 'source_char_start' | 'source_char_end'>;
      story_bible_proposals: TableDef<StoryBibleProposal, 'book_id' | 'proposal_type' | 'payload' | 'dedupe_key'>;
      story_outlines: TableDef<StoryOutline, 'book_id' | 'version_number' | 'created_by'>;
      story_outline_nodes: TableDef<StoryOutlineNode, 'story_outline_id' | 'node_type' | 'title'>;
      chapter_outlines: TableDef<ChapterOutline, 'chapter_id' | 'version_number' | 'created_by'>;
      chapter_outline_scenes: TableDef<ChapterOutlineScene, 'chapter_outline_id' | 'title'>;
      outline_beats: TableDef<OutlineBeat, 'chapter_outline_scene_id' | 'text'>;
      manuscript_versions: TableDef<ManuscriptVersion, 'book_id' | 'name' | 'version_number' | 'created_by'>;
      manuscript_version_sections: TableDef<
        ManuscriptVersionSection,
        'manuscript_version_id' | 'chapter_title' | 'section_order' | 'content'
      >;
    };
    Views: Record<string, never>;
    Functions: {
      chapter_state_hash: { Args: { p_chapter_id: string }; Returns: string };
      apply_chapter_version: {
        Args: {
          p_book_id: string;
          p_chapter_id: string;
          p_expected_hash: string;
          p_updates: unknown;
          p_inserts: unknown;
          p_order: unknown;
          p_removals: unknown;
          p_version_reason: string;
        };
        Returns: unknown;
      };
      apply_chapter_restore: {
        Args: { p_book_id: string; p_chapter_id: string; p_expected_hash: string; p_version_id: string };
        Returns: unknown;
      };
      manuscript_state_hash: { Args: { p_book_id: string }; Returns: string };
      apply_manuscript_restore: { Args: { p_book_id: string; p_snapshot_id: string; p_expected_hash: string }; Returns: unknown };
      apply_manuscript_version: {
        Args: {
          p_book_id: string;
          p_expected_hash: string;
          p_source: string;
          p_source_filename: string;
          p_chapter_updates: unknown;
          p_new_chapters: unknown;
          p_section_updates: unknown;
          p_section_inserts: unknown;
          p_section_removals: unknown;
          p_chapter_reorder: unknown;
          p_section_reorder: unknown;
          p_chapter_deactivations: unknown;
        };
        Returns: unknown;
      };
      deactivate_chapter: { Args: { p_book_id: string; p_chapter_id: string }; Returns: unknown };
      reactivate_chapter: { Args: { p_book_id: string; p_chapter_id: string; p_sort_order: number | null }; Returns: unknown };
      reactivate_chapter_to_end: { Args: { p_book_id: string; p_chapter_id: string }; Returns: unknown };
      add_chapter_at_end: { Args: { p_book_id: string; p_title: string }; Returns: unknown };
    };
  };
};
