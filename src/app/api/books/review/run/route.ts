import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { runReview, runDeepReview } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Deep (AI) review over a whole book runs a reasoning model and can take
// 60-90s. This ceiling must fit the Vercel plan: HOBBY caps functions at 60s,
// so we set 60 here. A large whole-book STANDALONE deep review may hit that
// limit; use chapter-scoped review, or the MCP host-mode tools (which do the
// reasoning host-side and return fast), for big books. Raise to 300 on Pro.
export const maxDuration = 60;

// Read-only over the manuscript: (re)generate + reconcile continuity findings.
// `deep: true` adds the evidence-verified AI candidate pass. Writes only to
// review_findings / review_ai_runs — never manuscript prose or canon.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await request.json()) as { book_id: string; chapter_id?: string; deep?: boolean };
  const result = body.deep ? await runDeepReview(supabase, body) : await runReview(supabase, body);
  return NextResponse.json(result.structuredContent);
}
