import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { gatherChapterPlanningContext, buildChapterPlanningRecap } from '@/lib/ai/planContext';

// "Where We Are Now" — pure data assembly, no AI call. Used to show the
// recap before the planning interview starts, and reused (via
// buildChapterPlanningRecap) inside the interview prompt itself, so what
// the author sees here and what the AI is told are exactly the same facts.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { bookId, chapterId } = (await request.json()) as { bookId: string; chapterId: string };
  if (!bookId || !chapterId) return NextResponse.json({ error: 'bookId and chapterId required' }, { status: 400 });

  try {
    const ctx = await gatherChapterPlanningContext(supabase, { bookId, chapterId });
    const recap = buildChapterPlanningRecap(ctx);
    return NextResponse.json({ recap, hasExistingOutline: Boolean(ctx.existingChapterOutline) });
  } catch (err) {
    console.error('ai/plan/chapter/recap failed', err);
    return NextResponse.json({ error: 'Could not assemble the recap — try again.' }, { status: 502 });
  }
}
