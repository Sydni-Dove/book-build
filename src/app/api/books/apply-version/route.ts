import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { applyManuscriptVersion } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WRITE: activate a writer-approved manuscript version. Snapshots the whole book
// first, then applies chapter/section changes in one transaction (RPC).
// Stale-checked. KEEP-only: never deletes a chapter.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as {
    book_id: string; incoming_content: string; expected_manuscript_hash: string;
    mappings?: Record<string, string>; section_removals?: string[]; chapter_deactivations?: string[]; source?: string; source_filename?: string;
  };
  const result = await applyManuscriptVersion(supabase, body);
  return NextResponse.json(result.structuredContent);
}
