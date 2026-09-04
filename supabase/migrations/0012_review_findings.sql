-- 0012_review_findings.sql
-- Persistence for Review & Continuity findings. Book-level, writer-friendly
-- states (not a bug tracker). Findings are evidence-first and reconciled on
-- re-run by a stable `fingerprint` (identity) with `evidence_hash` deciding
-- whether a resolved finding should reopen. Distinct from section_reviews/
-- review_issues (section-scoped, severity-based) which stay for their own use.

create table if not exists review_findings (
  id uuid primary key default uuid_generate_v4(),
  book_id uuid not null references books(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete set null,   -- optional anchor
  finding_type text not null check (finding_type in (
    'continuity','plot_thread','character','relationship','timeline','setup_payoff','repetition','knowledge','naming','writer_question'
  )),
  level text not null check (level in ('worth_checking','likely_conflict','open_question')),
  status text not null default 'open' check (status in ('open','intentional','resolved','watch')),
  title text not null,
  explanation text not null,
  question text,
  evidence jsonb not null default '[]'::jsonb,   -- [{chapter_id, chapter_number, section_id?, context}]
  entities jsonb not null default '[]'::jsonb,    -- [{kind, id?, name}]
  confidence real,                                -- internal 0..1, not shown as a scary score
  fingerprint text not null,                      -- stable identity for re-run reconciliation
  evidence_hash text,                             -- material-change detector
  source text not null default 'deterministic',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, fingerprint)
);
create index if not exists review_findings_book_id_idx on review_findings(book_id);

alter table review_findings enable row level security;
create policy "own review findings" on review_findings for all
  using (book_id in (select id from books where user_id = auth.uid()))
  with check (book_id in (select id from books where user_id = auth.uid()));

create trigger review_findings_set_updated_at before update on review_findings
  for each row execute function set_updated_at();
