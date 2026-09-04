import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { getVoiceReport } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only, deterministic whole-manuscript voice-consistency report. No LLM,
// no OpenAI cost, no writes.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await request.json()) as { book_id: string };
  const result = await getVoiceReport(supabase, body);
  return NextResponse.json(result.structuredContent);
}
