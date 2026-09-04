import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { applySectionVersion } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WRITE: replace one section with a writer-approved new version (snapshot first,
// stale-checked). Invoked only after the writer confirms in the UI.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as {
    book_id: string; section_id: string; chapter_id?: string;
    expected_content_hash: string; expected_updated_at?: string; approved_content: string;
  };
  const result = await applySectionVersion(supabase, body);
  return NextResponse.json(result.structuredContent);
}
