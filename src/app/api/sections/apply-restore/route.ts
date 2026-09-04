import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { applySectionRestore } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WRITE: restore one section to a historical version. Snapshot-first + stale-checked,
// exactly like Upload. Version content is read server-side by id. Invoked only after
// the writer confirms in the UI.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as {
    book_id: string; section_id: string; chapter_id?: string;
    version_id: string; expected_content_hash: string; expected_updated_at?: string;
  };
  const result = await applySectionRestore(supabase, body);
  return NextResponse.json(result.structuredContent);
}
