import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { applyChapterRestore } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WRITE: restore a chapter to a stored version. Snapshot-first + stale-checked,
// applied in one transaction (apply_chapter_restore RPC). After explicit confirm.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as { book_id: string; chapter_id: string; version_id: string; expected_chapter_hash: string };
  const result = await applyChapterRestore(supabase, body);
  return NextResponse.json(result.structuredContent);
}
