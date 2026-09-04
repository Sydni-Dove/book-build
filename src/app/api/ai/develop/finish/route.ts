import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { gatherSectionContext } from '@/lib/ai/context';
import { buildFinishDevelopmentPrompt, DEVELOPMENT_NOTES_SCHEMA, type DevelopmentNotesResult } from '@/lib/ai/prompts/develop';
import { callOpenAIStructured } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { interviewId } = (await request.json()) as { interviewId: string };

  const { data: interview } = await supabase.from('ai_interviews').select('*').eq('id', interviewId).single();
  if (!interview) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

  const { data: history } = await supabase
    .from('ai_interview_messages')
    .select('*')
    .eq('interview_id', interviewId)
    .order('created_at', { ascending: true });

  try {
    const ctx = await gatherSectionContext(supabase, {
      bookId: interview.book_id,
      chapterId: interview.chapter_id!,
      currentSectionId: interview.section_id ?? undefined
    });

    const prompt = buildFinishDevelopmentPrompt(ctx, interview.topic ?? '', history ?? []);
    const notes = await callOpenAIStructured<DevelopmentNotesResult>({
      ...prompt,
      toolName: 'development_notes',
      toolDescription: 'Return the structured Development Notes summary.',
      schema: DEVELOPMENT_NOTES_SCHEMA,
      meta: { supabase, feature: 'development_finish', bookId: interview.book_id }
    });

    await supabase
      .from('ai_interviews')
      .update({ status: 'complete', development_notes: notes })
      .eq('id', interviewId);

    return NextResponse.json({ notes });
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/develop/finish failed', err);
    return NextResponse.json({ error: 'Could not summarize the interview — your answers are still saved, try Finish again.' }, { status: 502 });
  }
}
