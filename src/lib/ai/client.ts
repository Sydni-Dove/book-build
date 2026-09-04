import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';
import {
  assertUnderCaps,
  logAiUsage,
  normalizeUsage,
  estimateCostUsd,
  type AiFeature
} from '@/lib/ai/usage';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

// Reasoning models (gpt-5*) spend part of `max_output_tokens` on internal
// reasoning tokens BEFORE any visible output is written. If the ceiling is too
// low the whole budget is consumed by reasoning and `output_text` comes back
// empty (status "incomplete", reason "max_output_tokens"). Billing is on actual
// tokens used, not the ceiling, so we keep these ceilings generous to guarantee
// the model always has room to emit its JSON/text after reasoning.
const DEFAULT_STRUCTURED_MAX_TOKENS = 8000;
const DEFAULT_TEXT_MAX_TOKENS = 2000;

// Provider resiliency policy (centralized, not per-route):
//  - maxRetries 1: retry a transient failure ONCE, never the SDK-default 2, so a
//    failing call can cost at most 2× rather than 3×. No app-level retry loops.
//  - timeout: long enough for a whole-book Deep Review (~78s observed) but far
//    below the SDK-default 10 minutes, so a stuck request can't hang. Individual
//    calls may raise it via `timeoutMs` (Deep Review does).
const MAX_RETRIES = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

type AiMessage = { role: 'user' | 'assistant'; content: string };

/** Metadata every direct provider call must carry: the RLS-scoped Supabase
 * client (for the cap check + usage log), a stable feature label, and the book
 * it belongs to (null for global flows). Optional per-call timeout override. */
export type AiCallMeta = {
  supabase: SupabaseClient<Database>;
  feature: AiFeature;
  bookId?: string | null;
  timeoutMs?: number;
};

function createOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env.local to use AI features.');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: MAX_RETRIES, timeout: DEFAULT_TIMEOUT_MS });
}

function categorizeError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  const status = (err as { status?: number })?.status;
  if (/timeout/i.test(name)) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number') return `api_error_${status}`;
  return 'api_error';
}

/**
 * Every AI feature in this app needs *structured* output (a list of
 * questions, a JSON review report, development notes), never a blob of
 * prose we then have to re-parse. OpenAI Structured Outputs keeps the
 * JSON Schema next to each prompt as the contract.
 *
 * Cost control (all direct callers inherit this automatically):
 *  1. pre-flight daily cap check (throws AiUsageLimitError when reached);
 *  2. usage + estimated cost logged to ai_usage_log on success, incomplete, and
 *     error — metadata only, never prompt/manuscript/output text.
 */
export async function callOpenAIStructured<T>(opts: {
  system: string;
  messages: AiMessage[];
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  meta: AiCallMeta;
}): Promise<T> {
  const { meta } = opts;
  const userId = await assertUnderCaps(meta.supabase);
  const openai = createOpenAI();
  const started = Date.now();

  let response: Awaited<ReturnType<typeof openai.responses.create>>;
  try {
    response = await openai.responses.create(
      {
        model: MODEL,
        instructions: opts.system,
        input: opts.messages,
        max_output_tokens: opts.maxTokens ?? DEFAULT_STRUCTURED_MAX_TOKENS,
        text: {
          format: {
            type: 'json_schema',
            name: opts.toolName,
            description: opts.toolDescription,
            schema: opts.schema,
            strict: false
          }
        }
      },
      { timeout: meta.timeoutMs ?? DEFAULT_TIMEOUT_MS }
    );
  } catch (err) {
    await logAiUsage({
      userId, feature: meta.feature, bookId: meta.bookId, model: MODEL, status: 'error',
      usage: normalizeUsage(undefined), estimatedCostUsd: null,
      durationMs: Date.now() - started, errorCategory: categorizeError(err)
    });
    throw err;
  }

  const usage = normalizeUsage(response.usage);
  const ok = !!response.output_text;
  const reason = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined;
  const cost = estimateCostUsd(MODEL, usage);
  await logAiUsage({
    userId, feature: meta.feature, bookId: meta.bookId, model: MODEL,
    status: ok ? 'ok' : 'incomplete',
    usage, estimatedCostUsd: cost.costUsd, unknownPricing: cost.unknownPricing,
    requestId: response.id, durationMs: Date.now() - started,
    errorCategory: ok ? null : (reason ?? 'empty')
  });

  if (!ok) {
    throw new Error(
      reason === 'max_output_tokens'
        ? 'OpenAI ran out of output budget before emitting JSON (raise maxTokens).'
        : 'OpenAI did not return structured JSON — check the prompt/schema.'
    );
  }

  return JSON.parse(response.output_text) as T;
}

/** Plain-text call for the one place we don't need structure: a single
 * Socratic follow-up question in the middle of an interview loop. */
export async function callOpenAIText(opts: {
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
  meta: AiCallMeta;
}): Promise<string> {
  const { meta } = opts;
  const userId = await assertUnderCaps(meta.supabase);
  const openai = createOpenAI();
  const started = Date.now();

  let response: Awaited<ReturnType<typeof openai.responses.create>>;
  try {
    response = await openai.responses.create(
      {
        model: MODEL,
        instructions: opts.system,
        input: opts.messages,
        max_output_tokens: opts.maxTokens ?? DEFAULT_TEXT_MAX_TOKENS
      },
      { timeout: meta.timeoutMs ?? DEFAULT_TIMEOUT_MS }
    );
  } catch (err) {
    await logAiUsage({
      userId, feature: meta.feature, bookId: meta.bookId, model: MODEL, status: 'error',
      usage: normalizeUsage(undefined), estimatedCostUsd: null,
      durationMs: Date.now() - started, errorCategory: categorizeError(err)
    });
    throw err;
  }

  const usage = normalizeUsage(response.usage);
  const ok = !!response.output_text;
  const cost = estimateCostUsd(MODEL, usage);
  await logAiUsage({
    userId, feature: meta.feature, bookId: meta.bookId, model: MODEL,
    status: ok ? 'ok' : 'incomplete',
    usage, estimatedCostUsd: cost.costUsd, unknownPricing: cost.unknownPricing,
    requestId: response.id, durationMs: Date.now() - started,
    errorCategory: ok ? null : (response.status === 'incomplete' ? response.incomplete_details?.reason ?? 'empty' : 'empty')
  });

  return response.output_text;
}
