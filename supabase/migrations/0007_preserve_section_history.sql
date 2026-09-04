-- 0007_preserve_section_history.sql
-- INTEGRITY FIX: removing a live section must never destroy its section_versions
-- history. Previously section_versions.section_id → writing_sections ON DELETE
-- CASCADE, so a chapter upload "Remove" (0005) or a chapter restore dropping a
-- section (0006) cascade-deleted that section's whole version history.
--
-- Fix (DB layer only — no app/RPC changes): change the FK to ON DELETE SET NULL
-- so a removed section DETACHES its history instead of destroying it, remember
-- where the history came from, and reconnect it automatically if the SAME
-- section id is re-created (which is exactly what chapter restore does — it
-- re-inserts sections with their original id). Detached rows are invisible to
-- the normal RLS policy (section_id is null) until they reconnect, which is the
-- accepted "inactive but preserved & recoverable" state. Deleting a whole
-- chapter or book still purges the history (dedicated triggers), so no orphans.

alter table section_versions add column if not exists detached_section_id uuid;
alter table section_versions add column if not exists detached_book_id uuid;
create index if not exists section_versions_detached_idx
  on section_versions(detached_section_id) where detached_section_id is not null;

-- section_id must be nullable to hold a detached (history-only) row
alter table section_versions alter column section_id drop not null;

-- swap CASCADE → SET NULL: removing a section detaches, never destroys, history
alter table section_versions drop constraint section_versions_section_id_fkey;
alter table section_versions add constraint section_versions_section_id_fkey
  foreign key (section_id) references writing_sections(id) on delete set null;

-- When a whole CHAPTER is deleted (directly or via book cascade), purge its
-- sections' history WITH it — this runs before the writing_sections cascade, so
-- those rows never detach into orphans. Section-level removal (a plain delete on
-- writing_sections while its chapter still exists) does NOT hit this path.
create or replace function purge_chapter_section_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from section_versions sv using writing_sections ws
    where sv.section_id = ws.id and ws.chapter_id = old.id;
  return old;
end;
$$;
drop trigger if exists trg_purge_chapter_section_history on chapters;
create trigger trg_purge_chapter_section_history before delete on chapters
  for each row execute function purge_chapter_section_history();

-- When a whole BOOK is deleted, also purge any already-detached history that
-- belonged to it (sections removed earlier, then the book deleted).
create or replace function purge_book_detached_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from section_versions where detached_book_id = old.id;
  return old;
end;
$$;
drop trigger if exists trg_purge_book_detached_history on books;
create trigger trg_purge_book_detached_history before delete on books
  for each row execute function purge_book_detached_history();

-- Section-level removal: stash where the history came from, then the FK SET NULL
-- detaches it (section_id → null). If the chapter is being deleted, the chapter
-- trigger already purged these rows, so this matches nothing (harmless).
create or replace function detach_section_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_book uuid;
begin
  select b.id into v_book from chapters c join books b on b.id = c.book_id where c.id = old.chapter_id;
  update section_versions set detached_section_id = old.id, detached_book_id = v_book
    where section_id = old.id;
  return old;
end;
$$;
drop trigger if exists trg_detach_section_history on writing_sections;
create trigger trg_detach_section_history before delete on writing_sections
  for each row execute function detach_section_history();

-- Re-creating a section with a previously-detached id (chapter restore re-inserts
-- the original id) reconnects its history — but only within the SAME book, so an
-- unrelated insert can never adopt another book's detached history.
create or replace function reconnect_section_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_book uuid;
begin
  select b.id into v_book from chapters c join books b on b.id = c.book_id where c.id = new.chapter_id;
  update section_versions
    set section_id = new.id, detached_section_id = null, detached_book_id = null
    where detached_section_id = new.id and section_id is null
      and detached_book_id is not distinct from v_book;
  return new;
end;
$$;
drop trigger if exists trg_reconnect_section_history on writing_sections;
create trigger trg_reconnect_section_history after insert on writing_sections
  for each row execute function reconnect_section_history();
