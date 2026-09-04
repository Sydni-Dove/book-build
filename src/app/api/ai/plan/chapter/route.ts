import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { gatherChapterPlanningContext, buildChapterPlanningRecap } from '@/lib/ai/planContext';
import { buildChapterInterviewTurn, continueChapterInterview } from '@/lib/ai/prompts/plan';
import { callOpenAIText } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

function splitSufficient(raw: string) {
  const sufficient = raw.includes('[SUFFICIENT]');
  const question = raw.replace('[SUFFICIENT]', '').trim();
  return { question, sufficient };
}

// "Plan This Chapter" / "Plan What Happens Next" — starts or continues the
// plan_chapter interview. Start: { bookId, chapterId, seedIdea? }.
// Continue: { interviewId, authorAnswer }.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json();

  try {
    if (body.interviewId) {
      const { interviewId, authorAnswer } = body as { interviewId: string; authorAnswer: string };

      const { data: interview } = await supabase.from('ai_interviews').select('*').eq('id', interviewId).single();
      if (!interview || !interview.chapter_id) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

      await supabase.from('ai_interview_messages').insert({ interview_id: interviewId, role: 'author', content: authorAnswer });

      const { data: history } = await supabase
        .from('ai_interview_messages')
        .select('*')
        .eq('interview_id', interviewId)
        .order('created_at', { ascending: true });

      const ctx = await gatherChapterPlanningContext(supabase, { bookId: interview.book_id, chapterId: interview.chapter_id });
      const recap = buildChapterPlanningRecap(ctx);

      const prompt = continueChapterInterview(recap, history ?? []);
      const raw = await callOpenAIText({ ...prompt, meta: { supabase, feature: 'plan_chapter', bookId: interview.book_id } });
      const { question, sufficient } = splitSufficient(raw);

      await supabase.from('ai_interview_messages').insert({ interview_id: interviewId, role: 'assistant', content: question });

      return NextResponse.json({ interviewId, question, sufficient });
    }

    const { bookId, chapterId, seedIdea } = body as { bookId: string; chapterId: string; seedIdea?: string };

    const { data: interview, error: insertError } = await supabase
      .from('ai_interviews')
      .insert({
        book_id: bookId,
        chapter_id: chapterId,
        interview_type: 'plan_chapter',
        topic: seedIdea ?? null,
        status: 'in_progress'
      })
      .select()
      .single();
    if (insertError || !interview) throw insertError;

    const ctx = await gatherChapterPlanningContext(supabase, { bookId, chapterId });
    const recap = buildChapterPlanningRecap(ctx);

    const prompt = buildChapterInterviewTurn(recap);
    const raw = await callOpenAIText({ ...prompt, meta: { supabase, feature: 'plan_chapter', bookId } });
    const { question, sufficient } = splitSufficient(raw);

    await supabase.from('ai_interview_messages').insert({ interview_id: interview.id, role: 'assistant', content: question });

    return NextResponse.json({ interviewId: interview.id, question, sufficient, recap });
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/plan/chapter failed', err);
    return NextResponse.json({ error: 'AI request failed. Your answers so far are safe — try again.' }, { status: 502 });
  }
}
