import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { buildNewBookInterviewTurn, continueNewBookInterview } from '@/lib/ai/prompts/plan';
import { callOpenAIText } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

function splitSufficient(raw: string) {
  const sufficient = raw.includes('[SUFFICIENT]');
  const question = raw.replace('[SUFFICIENT]', '').trim();
  return { question, sufficient };
}

// "Build My Story" — starts or continues the plan_new_book interview.
// Start: { bookId, seedIdea }.  Continue: { interviewId, authorAnswer }.
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
      if (!interview) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

      const { data: book } = await supabase.from('books').select('title').eq('id', interview.book_id).single();

      await supabase.from('ai_interview_messages').insert({ interview_id: interviewId, role: 'author', content: authorAnswer });

      const { data: history } = await supabase
        .from('ai_interview_messages')
        .select('*')
        .eq('interview_id', interviewId)
        .order('created_at', { ascending: true });

      const prompt = continueNewBookInterview(book?.title ?? '', interview.topic ?? '', history ?? []);
      const raw = await callOpenAIText({ ...prompt, meta: { supabase, feature: 'plan_new_book', bookId: interview.book_id } });
      const { question, sufficient } = splitSufficient(raw);

      await supabase.from('ai_interview_messages').insert({ interview_id: interviewId, role: 'assistant', content: question });

      return NextResponse.json({ interviewId, question, sufficient });
    }

    const { bookId, seedIdea } = body as { bookId: string; seedIdea: string };
    const { data: book } = await supabase.from('books').select('title').eq('id', bookId).single();
    if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

    const { data: interview, error: insertError } = await supabase
      .from('ai_interviews')
      .insert({ book_id: bookId, interview_type: 'plan_new_book', topic: seedIdea, status: 'in_progress' })
      .select()
      .single();
    if (insertError || !interview) throw insertError;

    const prompt = buildNewBookInterviewTurn(book.title, seedIdea);
    const raw = await callOpenAIText({ ...prompt, meta: { supabase, feature: 'plan_new_book', bookId } });
    const { question, sufficient } = splitSufficient(raw);

    await supabase.from('ai_interview_messages').insert({ interview_id: interview.id, role: 'assistant', content: question });

    return NextResponse.json({ interviewId: interview.id, question, sufficient });
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/plan/new-book failed', err);
    return NextResponse.json({ error: 'AI request failed. Your answers so far are safe — try again.' }, { status: 502 });
  }
}
