import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { previewSectionRestore } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only: diff the current section against a chosen historical version
// (Current vs Selected). Mutates nothing.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as { book_id: string; section_id: string; chapter_id?: string; version_id: string };
  const result = await previewSectionRestore(supabase, body);
  return NextResponse.json(result.structuredContent);
}
