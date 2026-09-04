import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { previewSectionVersion } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only: diff a proposed new section version against the current one.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as { book_id: string; section_id: string; chapter_id?: string; incoming_content: string };
  const result = await previewSectionVersion(supabase, body);
  return NextResponse.json(result.structuredContent);
}
