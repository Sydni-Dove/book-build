import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { applyManuscriptRestore } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WRITE: restore the book to a stored manuscript snapshot. Snapshot-first +
// stale-checked, applied in one transaction (RPC). KEEP-only: never deletes a
// chapter. After explicit confirmation.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as { book_id: string; snapshot_id: string; expected_manuscript_hash: string };
  const result = await applyManuscriptRestore(supabase, body);
  return NextResponse.json(result.structuredContent);
}
