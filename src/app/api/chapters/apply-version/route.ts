import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { applyChapterVersion } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WRITE: atomically replace a chapter with a writer-approved uploaded version.
// Snapshots the whole chapter first, then applies section updates/inserts/
// removals/reorder in one transaction (apply_chapter_version RPC). Stale-checked.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as {
    book_id: string; chapter_id: string; incoming_content: string;
    expected_chapter_hash: string; removals?: string[];
  };
  const result = await applyChapterVersion(supabase, body);
  return NextResponse.json(result.structuredContent);
}
