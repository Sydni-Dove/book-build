import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

type SB = SupabaseClient<Database>;

/**
 * Server-only service-role client used for TRUSTED usage accounting: writing
 * ai_usage_log rows and summing spend across ALL users for the application-wide
 * caps. RLS has no client INSERT policy (see migration 0015), so browsers can
 * never fabricate usage rows — only this path can. Never import this module
 * into a client component; the service key is a non-public env var and is only
 * read lazily here, on the server.
 */
let _admin: SB | null = null;
function adminClient(): SB {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Usage accounting requires SUPABASE_SERVICE_ROLE_KEY (server-side).');
  _admin = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

/**
 * Stable feature labels for every DIRECT Book Build OpenAI call. Passed
 * intentionally at each callsite (never inferred from the stack) so usage rows
 * are attributable per feature.
 */
export type AiFeature =
  | 'deep_review'
  | 'development_interview'
  | 'working_note_development'
  | 'help_think_through'
  | 'development_finish'
  | 'continue_questions'
  | 'plan_new_book'
  | 'plan_new_book_possibilities'
  | 'plan_new_book_finish'
  | 'plan_chapter'
  | 'plan_chapter_finish'
  | 'voice_revision';

const AI_FEATURES: readonly AiFeature[] = [
  'deep_review', 'development_interview', 'working_note_development', 'help_think_through', 'development_finish',
  'continue_questions', 'plan_new_book', 'plan_new_book_possibilities',
  'plan_new_book_finish', 'plan_chapter', 'plan_chapter_finish', 'voice_revision'
];

/** Coerce an untrusted string (e.g. from a request body) to a known feature. */
export function toAiFeature(v: unknown, fallback: AiFeature): AiFeature {
  return typeof v === 'string' && (AI_FEATURES as readonly string[]).includes(v) ? (v as AiFeature) : fallback;
}

// ---------------------------------------------------------------------------
// Pricing — a LOCAL ESTIMATE ONLY. These are USD per 1,000,000 tokens and are
// a snapshot of published OpenAI pricing; they can change and are never fetched
// at runtime. Update here (one place) if pricing moves. Used only to estimate
// spend for the daily safety cap and the usage summary — not for billing.
// ---------------------------------------------------------------------------
type Price = { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number };

export const MODEL_PRICING: Record<string, Price> = {
  'gpt-5':      { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 },
  'gpt-5-mini': { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2.0 },
  'gpt-5-nano': { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 }
};

/** The most expensive known rate — used as the CONSERVATIVE fallback for an
 * unknown model so its cost is never understated and it can never slip under a
 * cap by being priced as something cheaper. */
function mostExpensivePrice(): Price {
  return Object.values(MODEL_PRICING).reduce((a, b) => (b.outputPerMillion > a.outputPerMillion ? b : a));
}

/** Resolve pricing by longest matching prefix. An unknown model does NOT fall
 * back to a cheap default (that would understate spend); it is priced at the
 * most expensive known rate and flagged `known: false`. */
function priceFor(model: string): { price: Price; known: boolean } {
  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  const hit = keys.find((k) => model.startsWith(k));
  return hit ? { price: MODEL_PRICING[hit]!, known: true } : { price: mostExpensivePrice(), known: false };
}

export type NormalizedUsage = {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

/** Pull the token fields out of an OpenAI Responses `usage` object. Missing
 * fields become null (never guessed). */
export function normalizeUsage(usage: unknown): NormalizedUsage {
  const u = (usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  const n = (v: number | undefined) => (typeof v === 'number' ? v : null);
  return {
    input_tokens: n(u.input_tokens),
    cached_input_tokens: n(u.input_tokens_details?.cached_tokens),
    reasoning_tokens: n(u.output_tokens_details?.reasoning_tokens),
    output_tokens: n(u.output_tokens),
    total_tokens: n(u.total_tokens)
  };
}

/** Estimate USD cost from actual usage. Cached input is billed at the cheaper
 * rate; `output_tokens` already includes reasoning tokens (billed as output).
 * `costUsd` is null only when there are no token counts to estimate from.
 * `unknownPricing` is true when the model wasn't in the pricing map — the cost
 * is then a CONSERVATIVE upper-bound (most expensive known rate), never a cheap
 * default, so caps are never bypassed. */
export function estimateCostUsd(model: string, usage: NormalizedUsage): { costUsd: number | null; unknownPricing: boolean } {
  const { price: p, known } = priceFor(model);
  if (usage.input_tokens == null && usage.output_tokens == null) return { costUsd: null, unknownPricing: !known };
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const nonCached = Math.max(0, input - cached);
  const output = usage.output_tokens ?? 0;
  const cost =
    (nonCached / 1_000_000) * p.inputPerMillion +
    (cached / 1_000_000) * p.cachedInputPerMillion +
    (output / 1_000_000) * p.outputPerMillion;
  return { costUsd: Math.round(cost * 1_000_000) / 1_000_000, unknownPricing: !known }; // 6dp, matches numeric(10,6)
}

// ---------------------------------------------------------------------------
// Cost caps — application-safety limits (NOT subscription enforcement). Three
// layers, all server-side, all env-configurable so no personal dollar amount is
// hard-coded in source:
//   • per-user daily   (AI_DAILY_COST_LIMIT_USD)         default $1.00
//   • global daily     (AI_GLOBAL_DAILY_COST_LIMIT_USD)  default $2.00
//   • global monthly   (AI_GLOBAL_MONTHLY_COST_LIMIT_USD) OPT-IN (unset = off)
//
// Defaults rationale: the per-user and global-daily defaults are conservative
// dev ceilings that always protect the OpenAI account even if unconfigured (a
// runaway is capped at a couple of dollars/day). The global MONTHLY cap is a
// dollar figure that is inherently account-specific, so rather than invent an
// allowance we leave it OFF until explicitly configured — the daily ceilings
// already bound spend, and setting the env turns the monthly ceiling on.
// ---------------------------------------------------------------------------
export const DEFAULT_DAILY_COST_LIMIT_USD = 1.0;
export const DEFAULT_GLOBAL_DAILY_COST_LIMIT_USD = 2.0;

function envNumber(name: string): number | null {
  const raw = process.env[name];
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function dailyCostLimitUsd(): number {
  return envNumber('AI_DAILY_COST_LIMIT_USD') ?? DEFAULT_DAILY_COST_LIMIT_USD;
}
export function globalDailyCostLimitUsd(): number {
  return envNumber('AI_GLOBAL_DAILY_COST_LIMIT_USD') ?? DEFAULT_GLOBAL_DAILY_COST_LIMIT_USD;
}
/** Opt-in: null (unset) means no monthly ceiling is enforced. */
export function globalMonthlyCostLimitUsd(): number | null {
  return envNumber('AI_GLOBAL_MONTHLY_COST_LIMIT_USD');
}

export const AI_USAGE_LIMIT_MESSAGE =
  'AI is temporarily unavailable because the usage limit has been reached. Your work is safe and non-AI tools still work.';

export type AiCapCode = 'AI_USAGE_LIMIT_REACHED' | 'AI_GLOBAL_DAILY_LIMIT_REACHED' | 'AI_GLOBAL_MONTHLY_LIMIT_REACHED';

/** Base for every cost-cap block. All caps surface the SAME writer-facing
 * message; the specific `code` is for server logs / admin, not end users. */
export class AiCapError extends Error {
  constructor(readonly code: AiCapCode) {
    super(AI_USAGE_LIMIT_MESSAGE);
    this.name = 'AiCapError';
  }
}
/** Per-user daily cap reached (kept as a distinct type/name for compatibility). */
export class AiUsageLimitError extends AiCapError {
  constructor() { super('AI_USAGE_LIMIT_REACHED'); }
}
/** Application-wide daily or monthly cap reached. */
export class AiGlobalLimitError extends AiCapError {
  constructor(code: 'AI_GLOBAL_DAILY_LIMIT_REACHED' | 'AI_GLOBAL_MONTHLY_LIMIT_REACHED') { super(code); }
}

export function isAiCapError(err: unknown): err is AiCapError {
  const code = (err as { code?: string })?.code;
  return err instanceof AiCapError ||
    code === 'AI_USAGE_LIMIT_REACHED' || code === 'AI_GLOBAL_DAILY_LIMIT_REACHED' || code === 'AI_GLOBAL_MONTHLY_LIMIT_REACHED';
}
/** Back-compat alias — now true for ANY cost-cap block (per-user or global), so
 * existing callers keep returning the generic limit response. */
export const isAiUsageLimitError = isAiCapError;
export function aiCapErrorCode(err: unknown): AiCapCode {
  return (isAiCapError(err) ? (err as AiCapError).code : 'AI_USAGE_LIMIT_REACHED');
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function startOfMonthIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.toISOString();
}

/** Sum estimated spend + request count since `sinceIso`, optionally for one
 * user (omit for an application-wide total). Uses the given client — pass the
 * service-role admin client for global sums that must cross users. */
export async function sumCostUsd(supabase: SB, sinceIso: string, userId?: string): Promise<{ costUsd: number; requests: number }> {
  let q = supabase.from('ai_usage_log').select('estimated_cost_usd').gte('created_at', sinceIso);
  if (userId) q = q.eq('user_id', userId);
  const { data } = await q;
  const rows = data ?? [];
  const costUsd = rows.reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0);
  return { costUsd, requests: rows.length };
}

/** Sum today's estimated spend + request count for one user. Kept as its own
 * seam so it can be unit-tested with an explicit user id. */
export async function sumTodaysCostUsd(supabase: SB, userId: string): Promise<{ costUsd: number; requests: number }> {
  return sumCostUsd(supabase, startOfTodayIso(), userId);
}

/** Sum today's estimated spend for the signed-in user (RLS scopes to them). */
export async function todaysUsage(supabase: SB): Promise<{ userId: string | null; costUsd: number; requests: number }> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id ?? null;
  if (!userId) return { userId: null, costUsd: 0, requests: 0 };
  const { costUsd, requests } = await sumTodaysCostUsd(supabase, userId);
  return { userId, costUsd, requests };
}

/** Application-wide spend totals (all users) for admin visibility. Aggregate
 * only — never per-user detail. Uses the service-role client. */
export async function applicationSpend(): Promise<{ today: number; month: number }> {
  const admin = adminClient();
  const today = (await sumCostUsd(admin, startOfTodayIso())).costUsd;
  const month = (await sumCostUsd(admin, startOfMonthIso())).costUsd;
  return { today, month };
}

/**
 * Pre-flight cap check enforced BEFORE any model call. Order: per-user daily →
 * global daily → global monthly (if configured). Throws the matching cap error
 * (AiUsageLimitError / AiGlobalLimitError) so no OpenAI request is sent. Returns
 * the resolved userId for attribution. All sums run via the service-role admin
 * client (the global sums must cross users).
 *
 * Race note: read-then-act, not a transactional reservation. Simultaneous
 * requests can each pass; worst-case overshoot is bounded by (concurrent
 * requests) × per-call cost — cents at these token sizes. Acceptable for a
 * budget-safety cap; not a financial-grade reservation system.
 */
export async function assertUnderCaps(supabase: SB): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id ?? null;
  if (!userId) return null; // unauthenticated calls are gated by the routes themselves
  const admin = adminClient();

  const perUser = await sumCostUsd(admin, startOfTodayIso(), userId);
  if (perUser.costUsd >= dailyCostLimitUsd()) throw new AiUsageLimitError();

  const globalDay = await sumCostUsd(admin, startOfTodayIso());
  if (globalDay.costUsd >= globalDailyCostLimitUsd()) throw new AiGlobalLimitError('AI_GLOBAL_DAILY_LIMIT_REACHED');

  const monthlyLimit = globalMonthlyCostLimitUsd();
  if (monthlyLimit != null) {
    const globalMonth = await sumCostUsd(admin, startOfMonthIso());
    if (globalMonth.costUsd >= monthlyLimit) throw new AiGlobalLimitError('AI_GLOBAL_MONTHLY_LIMIT_REACHED');
  }
  return userId;
}

/** Best-effort TRUSTED append to ai_usage_log via the service-role client (RLS
 * has no client insert policy, so this is the only write path). NEVER throws —
 * a logging failure must not break the AI feature. Metadata only. */
export async function logAiUsage(row: {
  userId: string | null;
  feature: AiFeature;
  bookId?: string | null;
  model: string;
  status: 'ok' | 'incomplete' | 'error';
  usage: NormalizedUsage;
  estimatedCostUsd: number | null;
  unknownPricing?: boolean;
  requestId?: string | null;
  durationMs?: number | null;
  errorCategory?: string | null;
}): Promise<void> {
  try {
    if (!row.userId) return; // no authenticated user → nothing to attribute
    await adminClient().from('ai_usage_log').insert({
      user_id: row.userId,
      book_id: row.bookId ?? null,
      feature: row.feature,
      model: row.model,
      status: row.status,
      input_tokens: row.usage.input_tokens,
      cached_input_tokens: row.usage.cached_input_tokens,
      reasoning_tokens: row.usage.reasoning_tokens,
      output_tokens: row.usage.output_tokens,
      total_tokens: row.usage.total_tokens,
      estimated_cost_usd: row.estimatedCostUsd,
      unknown_pricing: row.unknownPricing ?? false,
      request_id: row.requestId ?? null,
      duration_ms: row.durationMs ?? null,
      error_category: row.errorCategory ?? null
    });
  } catch (err) {
    console.error('logAiUsage failed (non-fatal)', err);
  }
}
