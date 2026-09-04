-- Section by Section — migration 0003 (PROPOSED — NOT APPLIED)
--
-- This migration has NOT been run against any database, live or otherwise.
-- It is the data model for Manuscript / Book Version History, separate from
-- section_versions, which already exists and protects localized edits to
-- one writing section at a time — see 0001_init.sql.
--
-- (This file originally also contained PART B — PLAN. PLAN was approved and
-- built first, so its schema was split out into 0004_plan.sql, which IS
-- applied. This file now covers Version History only, and stays unapplied
-- until that feature is built next, per standing instruction: do not apply
-- this migration, and do not build the application code that depends on it,
-- until the visual prototype is explicitly approved and it's this feature's
-- turn.)

-- =============================================================================
-- MANUSCRIPT / BOOK VERSION HISTORY
-- =============================================================================
--
-- Three separate persistence concepts now exist and are never merged:
--   1. Autosave         — continuously protects the live text. Not a table;
--                          it's just writes to writing_sections.content.
--   2. section_versions  — protects localized edits / Fix With Me revisions
--                          to ONE section. Already exists (0001_init.sql).
--   3. manuscript_versions + manuscript_version_sections (below) — an
--                          intentional, whole-book checkpoint. Never created
--                          by autosave; only by an explicit "Save Version",
--                          or automatically before an operation that could
--                          affect many chapters at once.
--
-- "Current Draft" is NOT a row in manuscript_versions — it's simply the live
-- state of books/chapters/writing_sections, same as always. The version
-- history UI displays it as the first item (word/chapter counts computed
-- live), but nothing is snapshotted until the author — or a before_* system
-- event — deliberately creates one.

-- ---------------------------------------------------------------------------
-- 1. manuscript_versions — one row per saved checkpoint. word_count and
--    chapter_count are captured at snapshot time (not recomputed later) so
--    the version list can render instantly without joining the snapshot
--    table.
-- ---------------------------------------------------------------------------
create table manuscript_versions (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  name text not null,
  description text,
  version_number integer not null,
  reason text not null default 'manual_snapshot'
    check (reason in ('manual_snapshot', 'before_restore', 'before_book_revision', 'before_import_merge', 'milestone')),
  word_count integer not null default 0,
  chapter_count integer not null default 0,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (book_id, version_number)
);
create index manuscript_versions_book_id_idx on manuscript_versions(book_id);

-- name/description ARE editable after the fact (Rename, Add Note in the UI)
-- so this table gets a normal updated_at trigger — the mutability boundary
-- is metadata only, never content. Content immutability is enforced on
-- manuscript_version_sections below, where it actually matters.
alter table manuscript_versions add column updated_at timestamptz not null default now();
create trigger manuscript_versions_set_updated_at before update on manuscript_versions
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. manuscript_version_sections — the actual snapshotted content: enough to
--    reconstruct Book → Chapters → Sections as they existed at save time,
--    without a single giant concatenated blob (so chapter/section-level
--    comparison stays possible). chapter_number/chapter_title are
--    denormalized onto each row rather than pulled from a separate
--    snapshotted-chapters table — deliberately: the full chapter list for a
--    version is just `select distinct chapter_number, chapter_title ...
--    order by chapter_number`, which is enough for the structural diff
--    (chapter added/removed/renamed) the Compare screen needs, without a
--    second snapshot table to keep in sync.
--
--    source_section_id uses ON DELETE SET NULL, not CASCADE — if the live
--    section is later deleted or the chapter restructured, the snapshot
--    text must survive; only the pointer back to "which live row this was"
--    is cleared.
-- ---------------------------------------------------------------------------
create table manuscript_version_sections (
  id uuid primary key default uuid_generate_v4(),
  manuscript_version_id uuid not null references manuscript_versions(id) on delete cascade,
  source_section_id uuid references writing_sections(id) on delete set null,
  chapter_number integer,
  chapter_title text not null,
  scene_title text,
  section_order integer not null,
  content text not null,
  word_count integer not null default 0
);
create index manuscript_version_sections_version_id_idx on manuscript_version_sections(manuscript_version_id);

-- Saved versions are immutable — enforced at the database level, not just by
-- app convention, because this guarantee is the entire point of the
-- feature. Rows are inserted once when a version is saved and never
-- updated; deletion only happens via the parent manuscript_versions row
-- being deleted (Delete on a saved version).
create function prevent_version_section_mutation() returns trigger as $$
begin
  raise exception 'manuscript_version_sections rows are immutable — save a new manuscript_version instead of editing a saved one';
end;
$$ language plpgsql;
create trigger manuscript_version_sections_immutable before update on manuscript_version_sections
  for each row execute function prevent_version_section_mutation();

-- ---------------------------------------------------------------------------
-- 3. Restore — non-destructive by construction, entirely in application
--    code (no stored procedure needed, consistent with how continuity-check
--    thresholds are enforced in app code against plain columns in
--    0002_canon_scenes_imports.sql). "Restore This Version" always runs as:
--
--      1. Snapshot the CURRENT live state into a new manuscript_versions
--         row with reason = 'before_restore', named e.g.
--         "Before restore — Aug 30, 2026" — same insert path as a manual
--         Save Version, just with a system-generated name and reason.
--      2. Overwrite the live chapters/writing_sections content from the
--         selected manuscript_version_sections rows.
--      3. The selected version itself is never touched — restoring FROM a
--         version doesn't mutate it; it's just read.
--
--    Because step 1 always runs first, "Restore" can never actually lose
--    work — the immediately-prior live state is always one version away.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- RLS — same ownership-chain pattern as 0001 and 0002 throughout.
-- ---------------------------------------------------------------------------
alter table manuscript_versions enable row level security;
alter table manuscript_version_sections enable row level security;

create policy "own manuscript versions" on manuscript_versions for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own manuscript version sections" on manuscript_version_sections for all
  using (manuscript_version_id in (
    select id from manuscript_versions where book_id in (select id from books where user_id = auth.uid())
  ))
  with check (manuscript_version_id in (
    select id from manuscript_versions where book_id in (select id from books where user_id = auth.uid())
  ));
