-- 0018_book_type_and_prefs.sql
-- Book-type-specific review checks + per-user writing preferences.
--
-- Both columns live on EXISTING owned tables (books, profiles), so the existing
-- row-level security already scopes them per user — no new policies, no new auth,
-- no separate personalization tables. One checks system, different applicable
-- rule sets resolved by src/lib/ai/review/checkConfig.ts
-- (BOOK SETTINGS -> USER PROFILE PREFERENCES -> SYSTEM DEFAULTS).

-- Book-level: coarse manuscript type. Backfills existing books to 'fiction'
-- (Book Build's current corpus is narrative/Awakened), which keeps the narrative
-- Voice Pass checks active for them. A future nonfiction book is set to
-- 'nonfiction' and those fiction-only checks then do not run against it.
alter table books
  add column if not exists book_type text not null default 'fiction'
    check (book_type in ('fiction', 'nonfiction'));

-- Profile-level: reusable writing/editing preferences that apply across a user's
-- books unless a book overrides them. Empty by default; shape is WritingPreferences
-- in checkConfig.ts. Book-specific editorial accept/reject history is deliberately
-- NOT stored here — that stays project-scoped on review_findings.
alter table profiles
  add column if not exists writing_preferences jsonb not null default '{}'::jsonb;
