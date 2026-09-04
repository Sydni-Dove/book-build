-- 0014_ai_usage_log.sql
-- Application-safety cost control for DIRECT Book Build OpenAI calls (NOT
-- subscriptions/billing). One row per direct provider call captures token
-- usage + an ESTIMATED cost so the owner can answer "how much AI did Book
-- Build use today?" and a per-user daily cost cap can stop a runaway bug from
-- burning the OpenAI budget.
--
-- Metadata only. This table NEVER stores prompts, manuscript text, excerpts,
-- model output, or API keys — only counts, a feature label, and a model name.
--
-- MCP-host reasoning (Claude/ChatGPT interpreting deterministic tools) makes no
-- OpenAI call and therefore never writes here. Only direct provider calls do.

create table if not exists ai_usage_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid references books(id) on delete set null,   -- null for global flows
  feature text not null,                 -- e.g. deep_review, development_interview
  model text not null,
  status text not null,                  -- 'ok' | 'incomplete' | 'error'
  input_tokens integer,                  -- includes cached; null when unknown
  cached_input_tokens integer,
  reasoning_tokens integer,              -- subset of output_tokens (reporting only)
  output_tokens integer,                 -- billable output incl. reasoning
  total_tokens integer,
  estimated_cost_usd numeric(10,6),      -- ESTIMATE from a local pricing map
  request_id text,
  duration_ms integer,
  error_category text,                   -- e.g. 'incomplete', 'timeout', 'api_error'
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_log_user_created_idx on ai_usage_log (user_id, created_at);

alter table ai_usage_log enable row level security;

-- Owner-scoped: a user can only ever read their own usage rows, and can only
-- insert rows attributed to themselves. No update/delete from the client — the
-- log is append-only from the app's perspective (service role may prune tests).
create policy "own ai usage read" on ai_usage_log for select
  using (user_id = auth.uid());
create policy "own ai usage insert" on ai_usage_log for insert
  with check (user_id = auth.uid());
