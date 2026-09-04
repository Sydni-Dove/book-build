/**
 * Global cost caps + unknown-model pricing + trusted-write hardening.
 * Uses the service-role client for setup/sums and an anon client for the RLS
 * write check. Identity for assertUnderCaps is stubbed via a Proxy (the real
 * global sums still run against the DB through the admin client inside it).
 * Run: npx tsx scripts/ai-caps.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import {
  assertUnderCaps, sumCostUsd, applicationSpend, estimateCostUsd, normalizeUsage,
  logAiUsage, isAiCapError, aiCapErrorCode, MODEL_PRICING
} from '../src/lib/ai/usage.ts';
import { runReview, listReviewFindings } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const AWAKENED = '69c4e5ca-2529-4aab-9126-32873894d804';
const admin = createClient<Database>(url, svc, { auth: { persistSession: false } });
const asUser = (id: string) => new Proxy(admin, { get(t, p) { if (p === 'auth') return { getUser: async () => ({ data: { user: { id } } }) } as never; return (t as never)[p]; } }) as unknown as typeof admin;

let fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) fail++; };
const MARK = '__caps_test__';
const NU = normalizeUsage({ input_tokens: 2515, input_tokens_details: { cached_tokens: 2432 }, output_tokens: 5347, output_tokens_details: { reasoning_tokens: 3584 }, total_tokens: 7862 });

const ENV = ['AI_DAILY_COST_LIMIT_USD', 'AI_GLOBAL_DAILY_COST_LIMIT_USD', 'AI_GLOBAL_MONTHLY_COST_LIMIT_USD'] as const;
function setEnv(v: Partial<Record<(typeof ENV)[number], string>>) { for (const k of ENV) { if (v[k] != null) process.env[k] = v[k]!; else delete process.env[k]; } }
async function expectCap(label: string, code: string, fn: () => Promise<unknown>) {
  let threw: unknown = null; try { await fn(); } catch (e) { threw = e; }
  check(label, isAiCapError(threw) && aiCapErrorCode(threw) === code);
}
async function insertRow(userId: string, cost: number, model = 'gpt-5-mini') {
  await admin.from('ai_usage_log').insert({ user_id: userId, feature: 'deep_review', model, status: 'ok', estimated_cost_usd: cost, request_id: MARK } as never);
}

let user2: string | null = null;
try {
  await admin.from('ai_usage_log').delete().eq('request_id', MARK);

  // J · unknown model NOT priced as the cheap default; L · known price correct
  const mini = estimateCostUsd('gpt-5-mini', NU);
  const unknown = estimateCostUsd('mystery-model-9000', NU);
  check('L: known gpt-5-mini cost is exact + not flagged', (() => { const p = MODEL_PRICING['gpt-5-mini']!; const exp = ((2515 - 2432) / 1e6) * p.inputPerMillion + (2432 / 1e6) * p.cachedInputPerMillion + (5347 / 1e6) * p.outputPerMillion; return Math.abs(mini.costUsd! - Math.round(exp * 1e6) / 1e6) < 1e-6 && mini.unknownPricing === false; })());
  check('J: unknown model priced conservatively (> mini) + flagged', unknown.costUsd! > mini.costUsd! && unknown.unknownPricing === true);

  // K · unknown pricing cannot bypass cap: logged row has non-zero cost + flag
  await logAiUsage({ userId: OWNER, feature: 'deep_review', bookId: null, model: 'mystery-model-9000', status: 'ok', usage: NU, estimatedCostUsd: unknown.costUsd, unknownPricing: unknown.unknownPricing, requestId: MARK });
  const { data: uk } = await admin.from('ai_usage_log').select('estimated_cost_usd, unknown_pricing').eq('request_id', MARK).eq('model', 'mystery-model-9000');
  check('K: unknown-model row stored with non-zero cost + unknown_pricing flag', (uk ?? []).length === 1 && Number(uk![0]!.estimated_cost_usd) > 0 && uk![0]!.unknown_pricing === true);

  // E · one user contributes to global total (delta check)
  const base = (await applicationSpend()).today;
  await insertRow(OWNER, 0.05);
  const afterOwner = (await applicationSpend()).today;
  check('E: one user contributes to global today total', afterOwner >= base + 0.05 - 1e-9);

  // F · multiple users contribute to the SAME global total
  const made = await admin.auth.admin.createUser({ email: `caps-${Date.now()}@example.test`, password: `Pw!${Math.random().toString(36).slice(2)}`, email_confirm: true });
  user2 = made.data.user?.id ?? null;
  check('F-setup: throwaway second user created', !!user2);
  if (user2) {
    await insertRow(user2, 0.07);
    const afterTwo = (await applicationSpend()).today;
    check('F: multiple users contribute to global total', afterTwo >= afterOwner + 0.07 - 1e-9);
  }

  // G · aggregate only — applicationSpend exposes no per-user detail
  const appSpend = await applicationSpend();
  check('G: application total is aggregate-only (today/month numbers, no user rows)', Object.keys(appSpend).sort().join(',') === 'month,today' && typeof appSpend.today === 'number');

  // A · under all caps → allowed
  setEnv({ AI_DAILY_COST_LIMIT_USD: '999', AI_GLOBAL_DAILY_COST_LIMIT_USD: '999' });
  check('A: under personal + global caps → allowed (returns userId)', (await assertUnderCaps(asUser(OWNER))) === OWNER);

  // B · personal cap reached → AI_USAGE_LIMIT_REACHED (globals generous)
  setEnv({ AI_DAILY_COST_LIMIT_USD: '0.0001', AI_GLOBAL_DAILY_COST_LIMIT_USD: '999' });
  await expectCap('B: personal cap reached → blocked (AI_USAGE_LIMIT_REACHED)', 'AI_USAGE_LIMIT_REACHED', () => assertUnderCaps(asUser(OWNER)));

  // C · global daily reached → AI_GLOBAL_DAILY_LIMIT_REACHED (personal generous)
  setEnv({ AI_DAILY_COST_LIMIT_USD: '999', AI_GLOBAL_DAILY_COST_LIMIT_USD: '0.0001' });
  await expectCap('C: global daily cap reached → blocked (AI_GLOBAL_DAILY_LIMIT_REACHED)', 'AI_GLOBAL_DAILY_LIMIT_REACHED', () => assertUnderCaps(asUser(OWNER)));

  // D · global monthly reached → AI_GLOBAL_MONTHLY_LIMIT_REACHED (personal + daily generous)
  setEnv({ AI_DAILY_COST_LIMIT_USD: '999', AI_GLOBAL_DAILY_COST_LIMIT_USD: '999', AI_GLOBAL_MONTHLY_COST_LIMIT_USD: '0.0001' });
  await expectCap('D: global monthly cap reached → blocked (AI_GLOBAL_MONTHLY_LIMIT_REACHED)', 'AI_GLOBAL_MONTHLY_LIMIT_REACHED', () => assertUnderCaps(asUser(OWNER)));

  // H/I · deterministic tools still work while a cap is exceeded
  const rev = await runReview(asUser(OWNER), { book_id: AWAKENED });
  const list = await listReviewFindings(admin, { book_id: AWAKENED });
  check('H: deterministic Review runs while global cap exceeded', (rev.structuredContent as { status: string }).status === 'ok');
  check('I: deterministic MCP list tool unaffected by caps', (list.structuredContent as { status: string }).status === 'ok');
  setEnv({}); // restore defaults

  // M · a normal browser (anon) cannot fabricate usage rows (no INSERT policy)
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const { error: anonErr } = await anon.from('ai_usage_log').insert({ user_id: OWNER, feature: 'deep_review', model: 'gpt-5-mini', status: 'ok', estimated_cost_usd: 0.01, request_id: MARK } as never);
  const { count: forgedCount } = await admin.from('ai_usage_log').select('id', { count: 'exact', head: true }).eq('request_id', MARK).eq('estimated_cost_usd', 0.01).eq('model', 'gpt-5-mini');
  check('M: anon/browser insert is rejected by RLS (no forged rows)', !!anonErr && (forgedCount ?? 0) === 0);
} finally {
  setEnv({});
  await admin.from('ai_usage_log').delete().eq('request_id', MARK);
  if (user2) await admin.auth.admin.deleteUser(user2); // cascade drops their rows
  await admin.from('review_findings').delete().eq('book_id', AWAKENED);
  await admin.from('review_ai_runs').delete().eq('book_id', AWAKENED);
  const clean = (await admin.from('review_findings').select('id', { count: 'exact', head: true }).eq('book_id', AWAKENED)).count ?? 0;
  const canon = (await admin.from('canon_facts').select('id', { count: 'exact', head: true }).eq('book_id', AWAKENED)).count ?? 0;
  console.log(`\ncleanup → awakened review_findings=${clean}, canon_facts=${canon}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)'}`);
process.exit(fail === 0 ? 0 : 1);
