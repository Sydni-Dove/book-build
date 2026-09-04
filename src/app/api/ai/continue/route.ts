import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { gatherSectionContext } from '@/lib/ai/context';
import { buildContinuePrompt, CONTINUE_SCHEMA, type ContinueQuestion } from '@/lib/ai/prompts/continue';
import { callOpenAIStructured } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { chapterId, currentSectionId } = (await request.json()) as {
    chapterId: string;
    currentSectionId?: string;
  };
  if (!chapterId) return NextResponse.json({ error: 'chapterId required' }, { status: 400 });

  // RLS means this select only succeeds if the chapter's book belongs to `user`.
  const { data: chapter, error: chapterError } = await supabase
    .from('chapters')
    .select('book_id')
    .eq('id', chapterId)
    .single();
  if (chapterError || !chapter) return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });

  try {
    const ctx = await gatherSectionContext(supabase, {
      bookId: chapter.book_id,
      chapterId,
      currentSectionId
    });
    const prompt = buildContinuePrompt(ctx);
    const result = await callOpenAIStructured<{ questions: ContinueQuestion[] }>({
      ...prompt,
      toolName: 'propose_questions',
      toolDescription: 'Return the pre-writing questions for the author.',
      schema: CONTINUE_SCHEMA,
      meta: { supabase, feature: 'continue_questions', bookId: chapter.book_id }
    });
    return NextResponse.json(result);
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/continue failed', err);
    return NextResponse.json({ error: 'AI request failed. Nothing was saved — try again.' }, { status: 502 });
  }
}
