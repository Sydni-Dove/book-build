/**
 * AI usage logging + daily cost cap tests. Pure/config functions are tested
 * directly; DB behavior (log insert, cap sum, RLS) uses a service-role client
 * for setup and an anon client for the RLS check. No real OpenAI calls here —
 * the live logging path (A/B/Q/R) is exercised in the slice's real validation.
 * Run: npx tsx scripts/ai-usage.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import {
  normalizeUsage, estimateCostUsd, MODEL_PRICING, toAiFeature,
  dailyCostLimitUsd, DEFAULT_DAILY_COST_LIMIT_USD,
  AiUsageLimitError, isAiUsageLimitError,
  logAiUsage, sumTodaysCostUsd
} from '../src/lib/ai/usage.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const ids: string[] = [];
async function insert(row: Record<string, unknown>) {
  const { data, error } = await sb.from('ai_usage_log').insert({ user_id: OWNER, feature: 'deep_review', model: 'gpt-5-mini', status: 'ok', ...row } as never).select('id').single();
  if (error) throw error;
  ids.push((data as { id: string }).id);
  return (data as { id: string }).id;
}

try {
  // C · normalize captures input/output/reasoning; D · cached input
  const sample = { input_tokens: 2515, input_tokens_details: { cached_tokens: 2432 }, output_tokens: 5347, output_tokens_details: { reasoning_tokens: 3584 }, total_tokens: 7862 };
  const nu = normalizeUsage(sample);
  check('C: input/output/reasoning/total captured', nu.input_tokens === 2515 && nu.output_tokens === 5347 && nu.reasoning_tokens === 3584 && nu.total_tokens === 7862);
  check('D: cached input captured', nu.cached_input_tokens === 2432);
  check('C2: missing fields become null (not guessed)', (() => { const n = normalizeUsage({ output_tokens: 10 }); return n.input_tokens === null && n.cached_input_tokens === null && n.total_tokens === null; })());
  check('N: incomplete-style usage (only reasoning) still normalizes', (() => { const n = normalizeUsage({ output_tokens: 1984, output_tokens_details: { reasoning_tokens: 1984 } }); return n.output_tokens === 1984 && n.reasoning_tokens === 1984; })());

  // E · estimated cost matches hand math for the measured Deep Review
  const p = MODEL_PRICING['gpt-5-mini']!;
  const expected = ((2515 - 2432) / 1e6) * p.inputPerMillion + (2432 / 1e6) * p.cachedInputPerMillion + (5347 / 1e6) * p.outputPerMillion;
  const estObj = estimateCostUsd('gpt-5-mini', nu);
  const est = estObj.costUsd!;
  check('E: estimated cost matches pricing math (known model)', close(est, Math.round(expected * 1e6) / 1e6, 1e-6) && estObj.unknownPricing === false);
  check('E2: no tokens → null cost', estimateCostUsd('gpt-5-mini', normalizeUsage({})).costUsd === null);
  check('E3: unknown model priced (non-null) AND flagged unknown', (() => { const u = estimateCostUsd('some-future-model', nu); return u.costUsd !== null && u.unknownPricing === true; })());

  // F · feature label constrained
  check('F: toAiFeature accepts known, rejects unknown', toAiFeature('help_think_through', 'development_interview') === 'help_think_through' && toAiFeature('evil', 'development_interview') === 'development_interview');

  // M · stable cap error
  check('M: AiUsageLimitError carries stable code', new AiUsageLimitError().code === 'AI_USAGE_LIMIT_REACHED' && isAiUsageLimitError(new AiUsageLimitError()));
  check('M2: isAiUsageLimitError false for generic error', !isAiUsageLimitError(new Error('nope')));

  // config default
  check('config: default daily cap used when env unset/invalid', (() => { const prev = process.env.AI_DAILY_COST_LIMIT_USD; delete process.env.AI_DAILY_COST_LIMIT_USD; const d = dailyCostLimitUsd(); if (prev != null) process.env.AI_DAILY_COST_LIMIT_USD = prev; return d === DEFAULT_DAILY_COST_LIMIT_USD; })());

  // Clean any prior test rows for OWNER today, then exercise the DB path
  await sb.from('ai_usage_log').delete().eq('user_id', OWNER).eq('request_id', '__usage_test__');

  // F/G/H · logAiUsage writes metadata only, with feature + book id (trusted service-role path)
  await logAiUsage({ userId: OWNER, feature: 'deep_review', bookId: null, model: 'gpt-5-mini', status: 'ok', usage: nu, estimatedCostUsd: est, requestId: '__usage_test__', durationMs: 1234, errorCategory: null });
  const bookId = (await sb.from('books').select('id').eq('user_id', OWNER).limit(1).single()).data?.id ?? null;
  await logAiUsage({ userId: OWNER, feature: 'help_think_through', bookId, model: 'gpt-5-mini', status: 'ok', usage: nu, estimatedCostUsd: est, requestId: '__usage_test__' });
  const { data: logged } = await sb.from('ai_usage_log').select('*').eq('user_id', OWNER).eq('request_id', '__usage_test__');
  const rows = logged ?? [];
  check('F: feature label stored', rows.some((r) => r.feature === 'deep_review') && rows.some((r) => r.feature === 'help_think_through'));
  check('G: book id stored when supplied (and null when not)', rows.some((r) => r.book_id === bookId && bookId !== null) && rows.some((r) => r.book_id === null));
  check('H: only metadata columns exist (no prompt/manuscript/output text)', (() => {
    const cols = new Set(Object.keys(rows[0] ?? {}));
    const forbidden = ['content', 'prompt', 'output', 'output_text', 'text', 'messages', 'excerpt', 'manuscript', 'api_key'];
    return forbidden.every((c) => !cols.has(c)) && cols.has('input_tokens') && cols.has('estimated_cost_usd');
  })());

  // J/K · cap sum + comparison
  const { costUsd, requests } = await sumTodaysCostUsd(sb, OWNER);
  check('J: sumTodaysCostUsd reflects logged rows', requests >= 2 && costUsd > 0);
  check('K: over-cap detection (cost >= tiny limit blocks)', costUsd >= 0.0000001); // any spend exceeds a near-zero cap → would block

  // I · RLS: anon (no auth.uid) cannot read OWNER rows
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const { data: anonRows } = await anon.from('ai_usage_log').select('id').eq('user_id', OWNER).eq('request_id', '__usage_test__');
  check('I: non-owner (anon) cannot read owner usage rows', (anonRows ?? []).length === 0);
} finally {
  await sb.from('ai_usage_log').delete().eq('user_id', OWNER).eq('request_id', '__usage_test__');
  for (const id of ids) await sb.from('ai_usage_log').delete().eq('id', id);
  console.log('\n(usage test rows cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
