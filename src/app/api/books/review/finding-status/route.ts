import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { setReviewFindingStatus } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WRITE (review_findings only): set a finding's writer-managed state.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await request.json()) as { book_id: string; finding_id: string; status: 'open' | 'intentional' | 'resolved' | 'watch' };
  const result = await setReviewFindingStatus(supabase, body);
  return NextResponse.json(result.structuredContent);
}
