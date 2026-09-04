import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { buildBookOutlinePrompt, BOOK_OUTLINE_SCHEMA, type BookOutlineResult, type PlotPossibility } from '@/lib/ai/prompts/plan';
import { callOpenAIStructured } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

// The author chose a direction — turn it into a real, persisted book-level
// outline (story_outlines + story_outline_nodes). This is the one point in
// "Build My Story" that actually writes anything: everything before this
// (the interview, the possibilities) was exploration, not commitment.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { interviewId, chosenPossibility } = (await request.json()) as {
    interviewId: string;
    chosenPossibility: PlotPossibility;
  };

  const { data: interview } = await supabase.from('ai_interviews').select('*').eq('id', interviewId).single();
  if (!interview) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

  const { data: book } = await supabase.from('books').select('title').eq('id', interview.book_id).single();
  const { data: history } = await supabase
    .from('ai_interview_messages')
    .select('*')
    .eq('interview_id', interviewId)
    .order('created_at', { ascending: true });

  try {
    const prompt = buildBookOutlinePrompt(book?.title ?? '', interview.topic ?? '', history ?? [], chosenPossibility);
    const outline = await callOpenAIStructured<BookOutlineResult>({
      ...prompt,
      toolName: 'build_book_outline',
      toolDescription: 'Return the book-level outline (acts and chapters).',
      schema: BOOK_OUTLINE_SCHEMA,
      maxTokens: 12000,
      meta: { supabase, feature: 'plan_new_book_finish', bookId: interview.book_id }
    });

    // Only one is_current outline per book (partial unique index) — any
    // prior current outline is superseded, never deleted.
    const { data: priorCurrent } = await supabase
      .from('story_outlines')
      .select('version_number')
      .eq('book_id', interview.book_id)
      .eq('is_current', true)
      .maybeSingle();
    if (priorCurrent) {
      await supabase.from('story_outlines').update({ is_current: false }).eq('book_id', interview.book_id).eq('is_current', true);
    }

    const { data: newOutline, error: outlineError } = await supabase
      .from('story_outlines')
      .insert({
        book_id: interview.book_id,
        structure_type: outline.structure_type,
        structure_type_note: outline.structure_type_note ?? null,
        version_number: (priorCurrent?.version_number ?? 0) + 1,
        is_current: true,
        note: `${chosenPossibility.title} — ${chosenPossibility.premise}`,
        created_by: user.id
      })
      .select()
      .single();
    if (outlineError || !newOutline) throw outlineError;

    let sortOrder = 0;
    const actRows = [];
    for (const act of outline.acts) {
      const { data: actNode, error: actError } = await supabase
        .from('story_outline_nodes')
        .insert({
          story_outline_id: newOutline.id,
          parent_node_id: null,
          node_type: 'act',
          title: act.title,
          purpose: act.purpose ?? null,
          sort_order: sortOrder++
        })
        .select()
        .single();
      if (actError || !actNode) throw actError;

      let chapterSortOrder = 0;
      const chapterNodes = [];
      for (const chapter of act.chapters ?? []) {
        const { data: chapterNode, error: chapterError } = await supabase
          .from('story_outline_nodes')
          .insert({
            story_outline_id: newOutline.id,
            parent_node_id: actNode.id,
            node_type: 'chapter',
            title: chapter.title,
            purpose: chapter.purpose ?? null,
            sort_order: chapterSortOrder++
          })
          .select()
          .single();
        if (chapterError || !chapterNode) throw chapterError;
        chapterNodes.push(chapterNode);
      }
      actRows.push({ ...actNode, chapters: chapterNodes });
    }

    await supabase
      .from('ai_interviews')
      .update({ status: 'complete', story_outline_id: newOutline.id })
      .eq('id', interviewId);

    return NextResponse.json({ outline: newOutline, acts: actRows });
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/plan/new-book/finish failed', err);
    return NextResponse.json({ error: 'Could not build the outline — your interview answers are still saved, try again.' }, { status: 502 });
  }
}
