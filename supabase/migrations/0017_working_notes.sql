-- 0017_working_notes.sql
-- Private, non-canonical book workspace for loose ideas, thoughts, and drafts.
-- These rows are deliberately separate from manuscript prose, Story Canon,
-- Review findings, and AI interview transcripts.

create table if not exists working_notes (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Untitled note',
  content text not null default '',
  note_type text not null default 'note'
    check (note_type in ('thought', 'idea', 'note', 'draft')),
  status text not null default 'active'
    check (status in ('active', 'archived')),
  chapter_id uuid references chapters(id) on delete set null,
  section_id uuid references writing_sections(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists working_notes_user_id_idx on working_notes(user_id);
create index if not exists working_notes_book_status_updated_idx on working_notes(book_id, status, updated_at desc);
create index if not exists working_notes_chapter_id_idx on working_notes(chapter_id);
create index if not exists working_notes_section_id_idx on working_notes(section_id);

create or replace function validate_working_note_links()
returns trigger as $$
declare
  v_book_owner uuid;
  v_chapter_book uuid;
  v_section_chapter uuid;
  v_section_book uuid;
begin
  select user_id into v_book_owner from books where id = new.book_id;
  if v_book_owner is null then
    raise exception 'WORKING_NOTE_BOOK_NOT_FOUND';
  end if;

  if new.user_id is distinct from v_book_owner then
    raise exception 'WORKING_NOTE_OWNER_MISMATCH';
  end if;

  if new.chapter_id is not null then
    select book_id into v_chapter_book from chapters where id = new.chapter_id;
    if v_chapter_book is distinct from new.book_id then
      raise exception 'WORKING_NOTE_CHAPTER_MISMATCH';
    end if;
  end if;

  if new.section_id is not null then
    if new.chapter_id is null then
      raise exception 'WORKING_NOTE_SECTION_REQUIRES_CHAPTER';
    end if;

    select ws.chapter_id, c.book_id
      into v_section_chapter, v_section_book
    from writing_sections ws
    join chapters c on c.id = ws.chapter_id
    where ws.id = new.section_id;

    if v_section_book is distinct from new.book_id or v_section_chapter is distinct from new.chapter_id then
      raise exception 'WORKING_NOTE_SECTION_MISMATCH';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists working_notes_validate_links on working_notes;
create trigger working_notes_validate_links before insert or update on working_notes
  for each row execute function validate_working_note_links();

create trigger working_notes_set_updated_at before update on working_notes
  for each row execute function set_updated_at();

alter table working_notes enable row level security;
revoke all on table working_notes from anon, authenticated;
grant select, insert, update on table working_notes to authenticated;

create policy "own working notes read" on working_notes for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and book_id in (select id from books where user_id = (select auth.uid()))
  );

create policy "own working notes create" on working_notes for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and book_id in (select id from books where user_id = (select auth.uid()))
  );

create policy "own working notes update" on working_notes for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and book_id in (select id from books where user_id = (select auth.uid()))
  )
  with check (
    user_id = (select auth.uid())
    and book_id in (select id from books where user_id = (select auth.uid()))
  );

alter table ai_interviews add column if not exists working_note_id uuid references working_notes(id) on delete set null;
create index if not exists ai_interviews_working_note_id_idx on ai_interviews(working_note_id);

create or replace function validate_ai_interview_working_note()
returns trigger as $$
declare
  v_note_book uuid;
begin
  if new.working_note_id is null then
    return new;
  end if;

  select book_id into v_note_book from working_notes where id = new.working_note_id;
  if v_note_book is distinct from new.book_id then
    raise exception 'AI_INTERVIEW_WORKING_NOTE_MISMATCH';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_interviews_validate_working_note on ai_interviews;
create trigger ai_interviews_validate_working_note before insert or update on ai_interviews
  for each row execute function validate_ai_interview_working_note();
