import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { dailyCostLimitUsd, globalDailyCostLimitUsd, globalMonthlyCostLimitUsd, applicationSpend } from '@/lib/ai/usage';

// Aggregate application-wide totals are only exposed to configured admins
// (comma-separated user ids). Never per-user detail — just sums + limits.
function isAdmin(userId: string): boolean {
  return (process.env.AI_ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(userId);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Small owner-only usage summary: "how much AI did Book Build use today?"
// Metadata only (counts + estimated cost), RLS-scoped to the signed-in user.
// Not a dashboard — a single safe query surface for the current day.
export async function GET() {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  // RLS restricts this to the caller's own rows.
  const { data } = await supabase
    .from('ai_usage_log')
    .select('feature, status, input_tokens, output_tokens, total_tokens, estimated_cost_usd')
    .gte('created_at', start.toISOString());
  const rows = data ?? [];

  const byFeature: Record<string, { requests: number; total_tokens: number; estimated_cost_usd: number }> = {};
  let requests = 0, totalTokens = 0, cost = 0;
  for (const r of rows) {
    requests += 1;
    totalTokens += Number(r.total_tokens ?? 0);
    cost += Number(r.estimated_cost_usd ?? 0);
    const f = (byFeature[r.feature] ??= { requests: 0, total_tokens: 0, estimated_cost_usd: 0 });
    f.requests += 1;
    f.total_tokens += Number(r.total_tokens ?? 0);
    f.estimated_cost_usd += Number(r.estimated_cost_usd ?? 0);
  }
  const limit = dailyCostLimitUsd();
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

  // Personal section (owner-scoped, RLS).
  const payload: Record<string, unknown> = {
    date: start.toISOString().slice(0, 10),
    requests,
    total_tokens: totalTokens,
    estimated_cost_usd: round(cost),
    daily_limit_usd: limit,
    remaining_usd: Math.max(0, round(limit - cost)),
    limit_reached: cost >= limit,
    by_feature: byFeature
  };

  // Admin-only aggregate application totals + configured global limits. No
  // per-user breakdown is ever included.
  if (isAdmin(user.id)) {
    const app = await applicationSpend();
    const monthlyLimit = globalMonthlyCostLimitUsd();
    payload.application = {
      today_estimated_cost_usd: round(app.today),
      global_daily_limit_usd: globalDailyCostLimitUsd(),
      global_daily_limit_reached: app.today >= globalDailyCostLimitUsd(),
      month_estimated_cost_usd: round(app.month),
      global_monthly_limit_usd: monthlyLimit,
      global_monthly_limit_reached: monthlyLimit != null && app.month >= monthlyLimit
    };
  }

  return NextResponse.json(payload);
}
