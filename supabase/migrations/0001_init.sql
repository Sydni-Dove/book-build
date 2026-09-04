-- Section by Section — initial schema
-- Ownership model: every row traces back to a book, every book to a user.
-- RLS enforces that chain everywhere — the client is never trusted alone.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- books
-- ---------------------------------------------------------------------------
create type book_status as enum ('Planning', 'Drafting', 'Revising', 'Completed');

create table books (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  subtitle text,
  genre text,
  target_audience text,
  pov text,
  tense text,
  description text,
  author_notes text,
  status book_status not null default 'Planning',
  -- AI controls (spec item 24) — one row per book rather than a separate table
  ai_suggestion_level text not null default 'guided'
    check (ai_suggestion_level in ('light', 'guided', 'deep')),
  ai_toggles jsonb not null default '{
    "ask_before_prose": true,
    "continuity_warnings": true,
    "thread_reminders": true,
    "description_reminders": true,
    "reaction_reminders": true
  }'::jsonb,
  writing_unit_pref text not null default 'page'
    check (writing_unit_pref in ('paragraph', 'page', 'scene_section', 'full_scene')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger books_set_updated_at before update on books
  for each row execute function set_updated_at();
create index books_user_id_idx on books(user_id);

-- ---------------------------------------------------------------------------
-- chapters
-- ---------------------------------------------------------------------------
create type chapter_status as enum ('Not Started', 'Drafting', 'Needs Review', 'Reviewed', 'Complete');

create table chapters (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  chapter_number integer,
  title text not null default 'Untitled Chapter',
  summary text,
  status chapter_status not null default 'Not Started',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger chapters_set_updated_at before update on chapters
  for each row execute function set_updated_at();
create index chapters_book_id_idx on chapters(book_id);

-- ---------------------------------------------------------------------------
-- writing_sections — the actual writing unit. Never one giant chapter blob.
-- ---------------------------------------------------------------------------
create type section_status as enum ('Draft', 'Needs Attention', 'Reviewed', 'Complete');

create table writing_sections (
  id uuid primary key default uuid_generate_v4(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  sort_order integer not null default 0,
  title text,
  content text not null default '',
  summary text,
  status section_status not null default 'Draft',
  word_count integer not null default 0,
  -- the "Before You Continue" Q&A captured for this section, kept for
  -- the "Based on:" trust display (spec item 22) even after it scrolls away
  pre_writing_answers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger writing_sections_set_updated_at before update on writing_sections
  for each row execute function set_updated_at();
create index writing_sections_chapter_id_idx on writing_sections(chapter_id);

create table section_versions (
  id uuid primary key default uuid_generate_v4(),
  section_id uuid not null references writing_sections(id) on delete cascade,
  content text not null,
  version_reason text not null default 'manual_snapshot'
    check (version_reason in ('manual_snapshot', 'before_fix', 'chapter_review', 'autosave_hourly')),
  created_at timestamptz not null default now()
);
create index section_versions_section_id_idx on section_versions(section_id);

-- ---------------------------------------------------------------------------
-- story bible: characters, settings, relationships, story_threads
-- ---------------------------------------------------------------------------
create table characters (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  name text not null,
  role text,
  age text,
  appearance text,
  personality text,
  background text,
  goals text,
  fears text,
  beliefs text,
  voice_notes text,
  author_notes text,
  -- flexible, non-load-bearing details only — never a dumping ground
  details jsonb not null default '{}'::jsonb,
  first_appearance_chapter uuid references chapters(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger characters_set_updated_at before update on characters
  for each row execute function set_updated_at();
create index characters_book_id_idx on characters(book_id);

create table settings (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  name text not null,
  setting_type text,
  description text,
  layout text,
  lighting text,
  sounds text,
  smells text,
  sensory_details text,
  atmosphere text,
  important_objects text,
  canon_notes text,
  first_appearance_chapter uuid references chapters(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger settings_set_updated_at before update on settings
  for each row execute function set_updated_at();
create index settings_book_id_idx on settings(book_id);

create table relationships (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  character_a_id uuid not null references characters(id) on delete cascade,
  character_b_id uuid not null references characters(id) on delete cascade,
  relationship_type text,
  current_status text,
  history text,
  unresolved_tension text,
  last_meaningful_interaction uuid references writing_sections(id) on delete set null,
  notes text,
  updated_at timestamptz not null default now(),
  constraint relationships_distinct_characters check (character_a_id <> character_b_id)
);
create trigger relationships_set_updated_at before update on relationships
  for each row execute function set_updated_at();
create unique index relationships_pair_unique_idx on relationships (
  book_id,
  least(character_a_id, character_b_id),
  greatest(character_a_id, character_b_id)
);

create type thread_status as enum ('Active', 'Dormant', 'Resolved', 'Planned Later');

create table story_threads (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  title text not null,
  description text,
  status thread_status not null default 'Active',
  first_chapter_id uuid references chapters(id) on delete set null,
  last_chapter_id uuid references chapters(id) on delete set null,
  planned_payoff text,
  author_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger story_threads_set_updated_at before update on story_threads
  for each row execute function set_updated_at();
create index story_threads_book_id_idx on story_threads(book_id);

-- join table: which characters a thread involves
create table story_thread_characters (
  story_thread_id uuid not null references story_threads(id) on delete cascade,
  character_id uuid not null references characters(id) on delete cascade,
  primary key (story_thread_id, character_id)
);

-- ---------------------------------------------------------------------------
-- canon_facts — the provenance ledger. AI inference is NEVER written here
-- automatically; only the two author-driven source_types are ever inserted
-- by application code without an explicit "Add to Canon" action.
-- ---------------------------------------------------------------------------
create table canon_facts (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  fact_type text not null,
  subject_type text not null
    check (subject_type in ('character', 'setting', 'relationship', 'story_thread', 'book', 'general')),
  subject_id uuid,
  fact text not null,
  source_type text not null
    check (source_type in ('manuscript', 'author_answer', 'manual')),
  source_id uuid, -- e.g. the writing_section or ai_interview this came from
  canon_status text not null default 'tentative'
    check (canon_status in ('confirmed', 'tentative')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger canon_facts_set_updated_at before update on canon_facts
  for each row execute function set_updated_at();
create index canon_facts_book_id_idx on canon_facts(book_id);
create index canon_facts_subject_idx on canon_facts(subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- timeline_events
-- ---------------------------------------------------------------------------
create table timeline_events (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete set null,
  section_id uuid references writing_sections(id) on delete set null,
  event_order integer not null default 0,
  date_text text,
  time_text text,
  relative_time text,
  event_description text not null,
  characters_present uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger timeline_events_set_updated_at before update on timeline_events
  for each row execute function set_updated_at();
create index timeline_events_book_id_idx on timeline_events(book_id);

-- ---------------------------------------------------------------------------
-- ai_interviews / ai_interview_messages — Develop This, and anything else
-- that runs as a one-question-at-a-time loop
-- ---------------------------------------------------------------------------
create table ai_interviews (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete set null,
  section_id uuid references writing_sections(id) on delete set null,
  interview_type text not null
    check (interview_type in ('development', 'setting', 'character', 'continuity_fix')),
  topic text,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'complete', 'abandoned')),
  development_notes jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger ai_interviews_set_updated_at before update on ai_interviews
  for each row execute function set_updated_at();
create index ai_interviews_book_id_idx on ai_interviews(book_id);

create table ai_interview_messages (
  id uuid primary key default uuid_generate_v4(),
  interview_id uuid not null references ai_interviews(id) on delete cascade,
  role text not null check (role in ('assistant', 'author')),
  content text not null,
  created_at timestamptz not null default now()
);
create index ai_interview_messages_interview_id_idx on ai_interview_messages(interview_id);

-- ---------------------------------------------------------------------------
-- section_reviews / review_issues — Section Review + Chapter Review + Fix With Me
-- (schema ships in phase 1 so phase 2 doesn't need a migration; UI comes later)
-- ---------------------------------------------------------------------------
create table section_reviews (
  id uuid primary key default uuid_generate_v4(),
  section_id uuid not null references writing_sections(id) on delete cascade,
  overall_summary text,
  review_status text not null default 'clear' check (review_status in ('clear', 'issues_found')),
  created_at timestamptz not null default now()
);
create index section_reviews_section_id_idx on section_reviews(section_id);

create table review_issues (
  id uuid primary key default uuid_generate_v4(),
  review_id uuid not null references section_reviews(id) on delete cascade,
  issue_type text not null,
  severity text not null check (severity in ('critical', 'should_address', 'optional')),
  description text not null,
  quoted_context text,
  suggested_action text,
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger review_issues_set_updated_at before update on review_issues
  for each row execute function set_updated_at();
create index review_issues_review_id_idx on review_issues(review_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — a user can only ever touch rows under a book they own.
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;
alter table books enable row level security;
alter table chapters enable row level security;
alter table writing_sections enable row level security;
alter table section_versions enable row level security;
alter table characters enable row level security;
alter table settings enable row level security;
alter table relationships enable row level security;
alter table story_threads enable row level security;
alter table story_thread_characters enable row level security;
alter table canon_facts enable row level security;
alter table timeline_events enable row level security;
alter table ai_interviews enable row level security;
alter table ai_interview_messages enable row level security;
alter table section_reviews enable row level security;
alter table review_issues enable row level security;

create policy "own profile" on profiles for select using (auth.uid() = id);
create policy "update own profile" on profiles for update using (auth.uid() = id);

create policy "own books" on books for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own chapters" on chapters for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own sections" on writing_sections for all
  using (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ))
  with check (chapter_id in (
    select c.id from chapters c join books b on b.id = c.book_id where b.user_id = auth.uid()
  ));

create policy "own section versions" on section_versions for all
  using (section_id in (
    select ws.id from writing_sections ws
    join chapters c on c.id = ws.chapter_id
    join books b on b.id = c.book_id where b.user_id = auth.uid()
  ))
  with check (section_id in (
    select ws.id from writing_sections ws
    join chapters c on c.id = ws.chapter_id
    join books b on b.id = c.book_id where b.user_id = auth.uid()
  ));

create policy "own characters" on characters for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own settings" on settings for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own relationships" on relationships for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own story threads" on story_threads for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own story thread characters" on story_thread_characters for all
  using (story_thread_id in (
    select st.id from story_threads st join books b on b.id = st.book_id where b.user_id = auth.uid()
  ))
  with check (story_thread_id in (
    select st.id from story_threads st join books b on b.id = st.book_id where b.user_id = auth.uid()
  ));

create policy "own canon facts" on canon_facts for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own timeline events" on timeline_events for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own interviews" on ai_interviews for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create policy "own interview messages" on ai_interview_messages for all
  using (interview_id in (
    select id from ai_interviews where book_id in (select id from books where user_id = auth.uid())
  ))
  with check (interview_id in (
    select id from ai_interviews where book_id in (select id from books where user_id = auth.uid())
  ));

create policy "own section reviews" on section_reviews for all
  using (section_id in (
    select ws.id from writing_sections ws
    join chapters c on c.id = ws.chapter_id
    join books b on b.id = c.book_id where b.user_id = auth.uid()
  ))
  with check (section_id in (
    select ws.id from writing_sections ws
    join chapters c on c.id = ws.chapter_id
    join books b on b.id = c.book_id where b.user_id = auth.uid()
  ));

create policy "own review issues" on review_issues for all
  using (review_id in (
    select sr.id from section_reviews sr
    join writing_sections ws on ws.id = sr.section_id
    join chapters c on c.id = ws.chapter_id
    join books b on b.id = c.book_id where b.user_id = auth.uid()
  ))
  with check (review_id in (
    select sr.id from section_reviews sr
    join writing_sections ws on ws.id = sr.section_id
    join chapters c on c.id = ws.chapter_id
    join books b on b.id = c.book_id where b.user_id = auth.uid()
  ));
