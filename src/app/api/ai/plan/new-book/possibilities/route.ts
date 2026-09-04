import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { buildPlotPossibilitiesPrompt, PLOT_POSSIBILITIES_SCHEMA, type PlotPossibility } from '@/lib/ai/prompts/plan';
import { callOpenAIStructured } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

// "Give Me Plot Possibilities" — 3-5 genuinely different directions.
// Read-only against the outline tables: nothing is persisted here, because
// nothing is canon until the author picks one (POST .../finish does that).
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { interviewId } = (await request.json()) as { interviewId: string };

  const { data: interview } = await supabase.from('ai_interviews').select('*').eq('id', interviewId).single();
  if (!interview) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

  const { data: book } = await supabase.from('books').select('title').eq('id', interview.book_id).single();
  const { data: history } = await supabase
    .from('ai_interview_messages')
    .select('*')
    .eq('interview_id', interviewId)
    .order('created_at', { ascending: true });

  try {
    const prompt = buildPlotPossibilitiesPrompt(book?.title ?? '', interview.topic ?? '', history ?? []);
    const result = await callOpenAIStructured<{ possibilities: PlotPossibility[] }>({
      ...prompt,
      toolName: 'propose_plot_possibilities',
      toolDescription: 'Return the plot possibilities for the author to choose from.',
      schema: PLOT_POSSIBILITIES_SCHEMA,
      maxTokens: 8000,
      meta: { supabase, feature: 'plan_new_book_possibilities', bookId: interview.book_id }
    });
    return NextResponse.json(result);
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/plan/new-book/possibilities failed', err);
    return NextResponse.json({ error: 'AI request failed. Nothing was saved — try again.' }, { status: 502 });
  }
}
