-- 0013_review_ai_runs.sql
-- Cost/rerun control for the optional AI (Deep) review pass. One row per book+scope
-- records the manuscript hash at the last AI run, so a Deep Review can be skipped
-- (reusing existing AI findings) when the active manuscript hasn't changed. The
-- deterministic pass never needs this — it's cheap and always runs.

create table if not exists review_ai_runs (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  scope text not null,               -- 'book' or a chapter_id
  manuscript_hash text not null,
  created_at timestamptz not null default now(),
  unique (book_id, scope)
);

alter table review_ai_runs enable row level security;
create policy "own review ai runs" on review_ai_runs for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));
