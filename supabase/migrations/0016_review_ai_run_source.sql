-- 0016_review_ai_run_source.sql
-- Record which provider produced the last AI review for a (book, scope): the
-- standalone OpenAI path ('openai') or an MCP host that reasoned itself
-- ('mcp_host'). Visibility only — the hash gate still keys on (book_id, scope,
-- manuscript_hash). Because a host run persists genuinely-equivalent findings
-- through the SAME verify/reconcile pipeline into the SAME review_findings, it
-- is correct for a later standalone run to skip the paid OpenAI call when the
-- manuscript is unchanged (that is the MCP cost advantage).
alter table review_ai_runs add column if not exists source text;
