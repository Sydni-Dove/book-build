import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { proposeCanonFromFinding } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Creates a PENDING story_bible_proposals row from a finding. Never writes canon
// directly — the writer approves it through the existing Story Canon approval UI.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await request.json()) as { book_id: string; finding_id: string; fact: string };
  const result = await proposeCanonFromFinding(supabase, body);
  return NextResponse.json(result.structuredContent);
}
