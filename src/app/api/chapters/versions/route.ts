import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { listChapterVersions } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only: saved chapter versions (newest first) + current chapter metadata
// used to label "Current" and to stale-check a later restore.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as { book_id: string; chapter_id: string };
  const result = await listChapterVersions(supabase, body);
  return NextResponse.json(result.structuredContent);
}
