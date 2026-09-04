-- 0015_ai_usage_hardening.sql
-- Budget-safety hardening for ai_usage_log.
--
-- 1) Unknown-model pricing visibility: when a call uses a model with no entry in
--    the local pricing map, the estimate is computed at a CONSERVATIVE (most
--    expensive known) rate and flagged here, so it is never silently understated
--    and never bypasses the cost caps.
alter table ai_usage_log add column if not exists unknown_pricing boolean not null default false;

-- 2) Trusted writes only. Usage accounting rows are written exclusively by
--    server code using the service role (which bypasses RLS). Remove the client
--    INSERT policy so an authenticated browser cannot fabricate usage rows
--    (which could poison the application-wide cost total and DoS the AI features
--    for everyone). Owner-scoped READ stays in place.
drop policy if exists "own ai usage insert" on ai_usage_log;
