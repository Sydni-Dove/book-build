-- Section by Section — migration 0004: PLAN (plot & outline development)
--
-- APPLIED. Built first, ahead of Manuscript Version History (0003, still
-- proposed/unapplied) — PLAN is core writing workflow; Version History is
-- built as its own isolated feature afterward, per standing instruction not
-- to build two large features in the same pass.
--
-- PLAN is upstream of writing, not a replacement for the writing AI: it
-- decides what should happen; Help Me Continue / Develop This help write it
-- once it's known. It reuses the existing ai_interviews / ai_interview_
-- messages engine (0001_init.sql) for every guided-question flow —
-- "Build My Story," "Plan This Chapter," plot-hole questions — rather than
-- introducing a parallel conversation table. Plot Possibilities and
-- flagged plot holes are AI output within that same interview, not their
-- own tables: nothing there is canon, so nothing there needs a durable row
-- of its own until the author actually chooses one, at which point it
-- becomes an outline node/beat below (or, for character/setting/thread
-- facts, an ordinary canon_facts / story_bible_proposals row exactly as
-- everywhere else in the app).
--
-- Layer boundary, enforced by construction, not just convention:
--   STORY CANON (characters/settings/canon_facts/etc.) = what is true
--   OUTLINE (story_outlines / chapter_outlines / outline_beats below) = what is planned
--   MANUSCRIPT (chapters / writing_sections) = what has actually been written
-- Nothing in an outline becomes canon merely because it was planned — an
-- outline node/beat is never read as a canon_facts source, and nothing here
-- writes to canon_facts automatically.

alter table ai_interviews drop constraint ai_interviews_interview_type_check;
alter table ai_interviews add constraint ai_interviews_interview_type_check
  check (interview_type in ('development', 'setting', 'character', 'continuity_fix', 'continue', 'plan_new_book', 'plan_chapter'));

-- ---------------------------------------------------------------------------
-- story_outlines — the book-level plan: Book Arc → Act → Chapter →
-- Scene/Beat, via the self-referencing node tree below. Versioned like
-- chapter_outlines (below), but "lighter-weight than full manuscript
-- versioning" per spec — no separate content-snapshot table; a version
-- IS its tree of nodes, and an old version's nodes are simply never
-- edited once a newer version exists (enforced by the app only setting
-- is_current = false on old rows and never issuing further updates to
-- their nodes — no DB-level immutability trigger here, unlike manuscript
-- versions, because outline versions are explicitly allowed to be a
-- cheaper guarantee).
--
-- The partial unique index guarantees at the database level that a book
-- can never end up with two "current" outlines from a race or app bug.
-- ---------------------------------------------------------------------------
create table story_outlines (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  -- The app may recommend a structure but must never silently impose one —
  -- 'unstructured' is a first-class, permanent choice, not a placeholder.
  structure_type text not null default 'unstructured'
    check (structure_type in ('three_act', 'four_act', 'heros_journey', 'save_the_cat', 'mystery', 'romance', 'custom', 'unstructured')),
  structure_type_note text,
  version_number integer not null,
  is_current boolean not null default true,
  note text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (book_id, version_number)
);
create index story_outlines_book_id_idx on story_outlines(book_id);
create unique index story_outlines_one_current_idx on story_outlines(book_id) where is_current;

create table story_outline_nodes (
  id uuid primary key default uuid_generate_v4(),
  story_outline_id uuid not null references story_outlines(id) on delete cascade,
  parent_node_id uuid references story_outline_nodes(id) on delete cascade,
  node_type text not null check (node_type in ('act', 'chapter', 'scene_or_beat')),
  -- Set once a real chapter exists for this node. Planning can — and
  -- usually does — happen before the chapter itself is created, so this
  -- starts null and is backfilled when "Start Writing" materializes it.
  chapter_id uuid references chapters(id) on delete set null,
  title text not null,
  purpose text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger story_outline_nodes_set_updated_at before update on story_outline_nodes
  for each row execute function set_updated_at();
create index story_outline_nodes_outline_id_idx on story_outline_nodes(story_outline_id);
create index story_outline_nodes_parent_idx on story_outline_nodes(parent_node_id);

-- ---------------------------------------------------------------------------
-- chapter_outlines — the deep, one-chapter plan ("Plan This Chapter" /
-- "Detailed Chapter Outline"): purpose, opening state, end state, new
-- questions created, continuity notes. Distinct from a story_outline
-- node's one-line purpose — this is what the chapter-planning interview
-- actually produces. Same is_current + partial-unique-index versioning
-- pattern as story_outlines, so "Current Outline / Previous Outline
-- Versions" and restore-by-comparison work the same way at both levels.
-- ---------------------------------------------------------------------------
create table chapter_outlines (
  id uuid primary key default uuid_generate_v4(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  version_number integer not null,
  is_current boolean not null default true,
  purpose text,
  opening_state text,
  chapter_end_state text,
  new_questions_created text,
  continuity_notes text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (chapter_id, version_number)
);
create index chapter_outlines_chapter_id_idx on chapter_outlines(chapter_id);
create unique index chapter_outlines_one_current_idx on chapter_outlines(chapter_id) where is_current;

create table chapter_outline_scenes (
  id uuid primary key default uuid_generate_v4(),
  chapter_outline_id uuid not null references chapter_outlines(id) on delete cascade,
  title text not null,
  goal text,
  -- Optional link to an established Setting Builder profile; planning a
  -- scene in a place that has no profile yet is still allowed (null here),
  -- and should offer Setting Builder rather than block on it.
  setting_id uuid references settings(id) on delete set null,
  sort_order integer not null default 0
);
create index chapter_outline_scenes_outline_id_idx on chapter_outline_scenes(chapter_outline_id);

-- ---------------------------------------------------------------------------
-- outline_beats — Beat-by-Beat. A beat is a small movement, not
-- necessarily a full scene, so this is deliberately just an ordered,
-- freely-reorderable list under a chapter_outline_scenes row — reorder
-- is "update sort_order," nothing fancier (production UI uses Move
-- Up / Move Down controls, not drag-and-drop, per the mobile requirement).
-- ---------------------------------------------------------------------------
create table outline_beats (
  id uuid primary key default uuid_generate_v4(),
  chapter_outline_scene_id uuid not null references chapter_outline_scenes(id) on delete cascade,
  text text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger outline_beats_set_updated_at before update on outline_beats
  for each row execute function set_updated_at();
create index outline_beats_scene_id_idx on outline_beats(chapter_outline_scene_id);

-- Interviews can now reference the outline they're building toward, so a
-- "Plan This Chapter" session's questions stay attached to the outline they
-- produced (both nullable — most other interview types never set these).
alter table ai_interviews add column story_outline_id uuid references story_outlines(id) on delete set null;
alter table ai_interviews add column chapter_outline_id uuid references chapter_outlines(id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS — same ownership-chain pattern as 0001 and 0002 throughout.
-- ---------------------------------------------------------------------------
alter table story_outlines enable row level security;
alter table story_outline_nodes enable row level security;
alter table chapter_outlines enable row level security;
alter table chapter_outline_scenes enable row level security;
alter table outline_beats enable row level security;

create policy "own story outlines" on story_outlines for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own story outline nodes" on story_outline_nodes for all
  using (story_outline_id in (
    select id from story_outlines where book_id in (select id from books where user_id = auth.uid())
  ))
  with check (story_outline_id in (
    select id from story_outlines where book_id in (select id from books where user_id = auth.uid())
  ));

create policy "own chapter outlines" on chapter_outlines for all
  using (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ))
  with check (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ));

create policy "own chapter outline scenes" on chapter_outline_scenes for all
  using (chapter_outline_id in (
    select co.id from chapter_outlines co
    join chapters c on c.id = co.chapter_id
    join books b on b.id = c.book_id
    where b.user_id = auth.uid()
  ))
  with check (chapter_outline_id in (
    select co.id from chapter_outlines co
    join chapters c on c.id = co.chapter_id
    join books b on b.id = c.book_id
    where b.user_id = auth.uid()
  ));

create policy "own outline beats" on outline_beats for all
  using (chapter_outline_scene_id in (
    select cos.id from chapter_outline_scenes cos
    join chapter_outlines co on co.id = cos.chapter_outline_id
    join chapters c on c.id = co.chapter_id
    join books b on b.id = c.book_id
    where b.user_id = auth.uid()
  ))
  with check (chapter_outline_scene_id in (
    select cos.id from chapter_outline_scenes cos
    join chapter_outlines co on co.id = cos.chapter_outline_id
    join chapters c on c.id = co.chapter_id
    join books b on b.id = c.book_id
    where b.user_id = auth.uid()
  ));
