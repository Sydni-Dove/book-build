-- Section by Section — migration 0002
-- Scenes (optional), the three-axis canon model, the reality layer, story
-- thread pacing, durable conflict history, and the manuscript import
-- pipeline. Builds on 0001_init.sql; nothing here has been applied to a
-- live database yet.

-- ---------------------------------------------------------------------------
-- 1. Scenes — optional. A Section may reference at most one Scene (a plain
--    nullable FK already guarantees that) and cannot cross a scene boundary.
--    If multi-scene sections are ever needed, that's a future
--    `section_scenes(section_id, scene_id, sort_order)` join table — not a
--    retrofit of this column.
-- ---------------------------------------------------------------------------
create table scenes (
  id uuid primary key default uuid_generate_v4(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  title text,
  pov_character_id uuid references characters(id) on delete set null,
  setting_id uuid references settings(id) on delete set null,
  time_context text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger scenes_set_updated_at before update on scenes
  for each row execute function set_updated_at();
create index scenes_chapter_id_idx on scenes(chapter_id);

alter table writing_sections add column scene_id uuid references scenes(id) on delete set null;
create index writing_sections_scene_id_idx on writing_sections(scene_id);

-- ---------------------------------------------------------------------------
-- 2. Continuity-check plumbing on writing_sections — cheap skip guard +
--    concurrency guard, so AI analysis never runs on unchanged content or
--    twice at once. Thresholds (150 words / 90s) are enforced in app code
--    against these columns, not in the database.
-- ---------------------------------------------------------------------------
alter table writing_sections add column content_hash text;
alter table writing_sections add column last_ai_check_at timestamptz;
alter table writing_sections add column last_ai_check_content_hash text;
alter table writing_sections add column last_ai_checked_word_count integer not null default 0;
alter table writing_sections add column ai_check_state text not null default 'idle'
  check (ai_check_state in ('idle', 'queued', 'running'));

-- ---------------------------------------------------------------------------
-- 3. Canon facts — three independent axes, replacing the old two-value
--    canon_status. Existing rows (none in any live database yet, but this
--    keeps the migration honest) are remapped rather than dropped.
-- ---------------------------------------------------------------------------
update canon_facts set canon_status = case
  when canon_status = 'confirmed' then 'author_canon'
  else 'working_note'
end;
alter table canon_facts drop constraint canon_facts_canon_status_check;
alter table canon_facts alter column canon_status set default 'working_note';
alter table canon_facts add constraint canon_facts_canon_status_check
  check (canon_status in ('working_note', 'author_canon'));

update canon_facts set source_type = case
  when source_type = 'manuscript' then 'manuscript_detected'
  when source_type = 'author_answer' then 'interview_answer'
  else 'manual'
end;
alter table canon_facts drop constraint canon_facts_source_type_check;
alter table canon_facts add constraint canon_facts_source_type_check
  check (source_type in ('interview_answer', 'before_you_continue', 'manual', 'ai_inference', 'manuscript_detected'));

alter table canon_facts add column manuscript_status text not null default 'not_checked'
  check (manuscript_status in ('not_checked', 'proposed_match', 'confirmed_in_manuscript', 'contradicted'));

alter table canon_facts add column reader_knowledge text
  check (reader_knowledge in ('reader_knows', 'reader_suspects', 'intentionally_hidden', 'not_yet_introduced', 'should_know_by_now'));

alter table canon_facts add column reality_layer text not null default 'unclassified'
  check (reality_layer in (
    'unclassified', 'physical_event', 'dream', 'vision', 'supernatural_perception',
    'internal_thought', 'memory', 'prophecy_revelation', 'character_interpretation', 'narrator_confirmed_fact'
  ));

-- ---------------------------------------------------------------------------
-- 4. Conflict history — durable restoration for the "contradicted" state.
--    previous_manuscript_status + previous_fact_text are snapshotted at the
--    moment a conflict is raised, so "Keep Original" / "It's Temporary" /
--    "Not a Conflict" can restore the prior state without the app ever
--    having to remember it in memory. Rows are inserted once (pending) and
--    updated once (on resolution) — never deleted.
-- ---------------------------------------------------------------------------
create table canon_fact_conflicts (
  id uuid primary key default uuid_generate_v4(),
  canon_fact_id uuid not null references canon_facts(id) on delete cascade,
  section_id uuid references writing_sections(id) on delete set null,
  previous_manuscript_status text not null
    check (previous_manuscript_status in ('not_checked', 'proposed_match', 'confirmed_in_manuscript')),
  previous_fact_text text not null,
  conflicting_excerpt text not null,
  description text,
  resolution text not null default 'pending'
    check (resolution in ('pending', 'keep_original', 'update_canon', 'temporary', 'not_conflict')),
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index canon_fact_conflicts_canon_fact_id_idx on canon_fact_conflicts(canon_fact_id);

-- ---------------------------------------------------------------------------
-- 5. Timeline events — same reality layer as canon facts, same corrected
--    default. A dream-sequence event is tagged as such, not silently
--    treated as part of the physical timeline.
-- ---------------------------------------------------------------------------
alter table timeline_events add column reality_layer text not null default 'unclassified'
  check (reality_layer in (
    'unclassified', 'physical_event', 'dream', 'vision', 'supernatural_perception',
    'internal_thought', 'memory', 'prophecy_revelation', 'character_interpretation', 'narrator_confirmed_fact'
  ));

-- ---------------------------------------------------------------------------
-- 6. Story threads — Next Expected Beat, so a deliberately-parked thread
--    (sequel material, "later in book") doesn't trigger a dormant-thread
--    nudge it was never supposed to get.
-- ---------------------------------------------------------------------------
alter table story_threads add column next_expected_beat text
  check (next_expected_beat in ('soon', 'current_arc', 'later_in_book', 'sequel', 'no_planned_timing', 'custom'));
alter table story_threads add column next_expected_beat_note text;

-- ---------------------------------------------------------------------------
-- 7. Section version reasons — tightened to the four deliberate AI-edit
--    triggers plus manual; "autosave_hourly" is gone (autosave never
--    snapshots) and "chapter_review" folds into "before_chapter_revision".
-- ---------------------------------------------------------------------------
update section_versions set version_reason = case
  when version_reason = 'before_fix' then 'before_fix_with_me'
  when version_reason = 'chapter_review' then 'before_chapter_revision'
  when version_reason = 'autosave_hourly' then 'manual_snapshot'
  else version_reason
end;
alter table section_versions drop constraint section_versions_version_reason_check;
alter table section_versions add constraint section_versions_version_reason_check
  check (version_reason in ('manual_snapshot', 'before_fix_with_me', 'before_ai_edit', 'before_continuity_correction', 'before_chapter_revision'));

-- ---------------------------------------------------------------------------
-- 8. AI interviews — 'continue' added for the conversational Before You
--    Continue flow, which now reuses this same interview engine.
-- ---------------------------------------------------------------------------
alter table ai_interviews drop constraint ai_interviews_interview_type_check;
alter table ai_interviews add constraint ai_interviews_interview_type_check
  check (interview_type in ('development', 'setting', 'character', 'continuity_fix', 'continue'));

-- ---------------------------------------------------------------------------
-- 9. Manuscript imports — the .docx itself lives in Supabase Storage; this
--    table holds only the pointer, metadata, hash, owner, and processing
--    state. `unique(book_id, file_hash)` makes re-uploading the identical
--    file resume the existing import rather than duplicating it.
-- ---------------------------------------------------------------------------
create table manuscript_imports (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  storage_bucket text not null default 'manuscript-imports',
  storage_path text not null,
  original_filename text not null,
  file_size_bytes bigint,
  file_hash text not null,
  mime_type text,
  processing_state text not null default 'uploaded'
    check (processing_state in ('uploaded', 'parsing', 'chapters_detected', 'chapters_confirmed', 'analyzing', 'complete', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, file_hash)
);
create trigger manuscript_imports_set_updated_at before update on manuscript_imports
  for each row execute function set_updated_at();
create index manuscript_imports_book_id_idx on manuscript_imports(book_id);

-- ---------------------------------------------------------------------------
-- 10. Import chapters — one row per detected chapter boundary. This is what
--     makes retries idempotent: `unique(import_id, sequence_index)` means a
--     retried job upserts against the same row instead of creating a new
--     one, and materialization (chapter_id set) and analysis
--     (analysis_state) are tracked as two separate, independently-checkable
--     steps.
-- ---------------------------------------------------------------------------
create table import_chapters (
  id uuid primary key default uuid_generate_v4(),
  import_id uuid not null references manuscript_imports(id) on delete cascade,
  sequence_index integer not null,
  detected_title text,
  source_char_start integer not null,
  source_char_end integer not null,
  chapter_id uuid references chapters(id) on delete set null,
  sections_materialized boolean not null default false,
  analysis_state text not null default 'pending'
    check (analysis_state in ('pending', 'running', 'complete', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (import_id, sequence_index)
);
create trigger import_chapters_set_updated_at before update on import_chapters
  for each row execute function set_updated_at();
create index import_chapters_import_id_idx on import_chapters(import_id);

-- ---------------------------------------------------------------------------
-- 11. Story Bible proposals — AI-extracted candidates, pending author
--     approval. Dedup is conceptually scoped to (import_id, chapter_id,
--     dedupe_key) — NOT book_id-agnostic collapsing — on purpose: retrying
--     the same chapter's analysis must not insert a duplicate, but chapter
--     10 offering new or stronger evidence about an entity chapter 3
--     already proposed is a different, legitimate proposal, not a
--     duplicate. The application layer upserts on this key and only
--     overwrites a row still in 'pending' — an already-approved/edited/
--     rejected proposal is never silently touched by a retry.
--
--     Standard Postgres UNIQUE treats NULLs as distinct from each other, so
--     a plain `unique (import_id, chapter_id, dedupe_key)` would silently
--     fail to collide two rows that both have chapter_id = NULL (a
--     no-chapter proposal) or, in principle, import_id = NULL — exactly the
--     idempotency guarantee this table exists to provide. Rather than lean
--     on `unique nulls not distinct` (Postgres 15+ only, and this
--     migration hasn't been run against a live project yet, so the server
--     version isn't confirmed), this uses a COALESCE-based functional
--     unique index, which is correct on any Postgres version Supabase
--     could be running. book_id is included explicitly and is never
--     NULL, so two different books can never collide even in the
--     COALESCE-to-sentinel case where both also happen to have NULL
--     import_id and NULL chapter_id.
-- ---------------------------------------------------------------------------
create table story_bible_proposals (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  import_id uuid references manuscript_imports(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete set null,
  section_id uuid references writing_sections(id) on delete set null,
  proposal_type text not null
    check (proposal_type in ('character', 'setting', 'relationship', 'story_thread', 'timeline_event', 'canon_fact')),
  payload jsonb not null,
  supporting_excerpt text,
  source_char_start integer,
  source_char_end integer,
  dedupe_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'edited', 'rejected')),
  approved_record_table text,
  approved_record_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger story_bible_proposals_set_updated_at before update on story_bible_proposals
  for each row execute function set_updated_at();
create index story_bible_proposals_book_id_idx on story_bible_proposals(book_id);

-- NULL-safe dedupe: (0) same book always required: NULL never crosses
-- book_id, so a NULL import_id/chapter_id in one book can never collide
-- with a NULL import_id/chapter_id in another. (1) & (3) re-running the
-- same extraction (same import, same or absent chapter) collides on the
-- coalesced key. (2) a different chapter_id is a different key, so new
-- per-chapter evidence is preserved. (4) book_id plus a real (non-null)
-- import_id already scopes to one import; the sentinel only ever applies
-- within that same book.
create unique index story_bible_proposals_dedupe_idx on story_bible_proposals (
  book_id,
  coalesce(import_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(chapter_id, '00000000-0000-0000-0000-000000000000'::uuid),
  dedupe_key
);

-- ---------------------------------------------------------------------------
-- RLS — same ownership-chain pattern as 0001 throughout.
-- ---------------------------------------------------------------------------
alter table scenes enable row level security;
alter table canon_fact_conflicts enable row level security;
alter table manuscript_imports enable row level security;
alter table import_chapters enable row level security;
alter table story_bible_proposals enable row level security;

create policy "own scenes" on scenes for all
  using (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ))
  with check (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ));

create policy "own canon fact conflicts" on canon_fact_conflicts for all
  using (canon_fact_id in (
    select id from canon_facts where book_id in (select id from books where user_id = auth.uid())
  ))
  with check (canon_fact_id in (
    select id from canon_facts where book_id in (select id from books where user_id = auth.uid())
  ));

create policy "own manuscript imports" on manuscript_imports for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own import chapters" on import_chapters for all
  using (import_id in (
    select id from manuscript_imports where book_id in (select id from books where user_id = auth.uid())
  ))
  with check (import_id in (
    select id from manuscript_imports where book_id in (select id from books where user_id = auth.uid())
  ));

create policy "own story bible proposals" on story_bible_proposals for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));
