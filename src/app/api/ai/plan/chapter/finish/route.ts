import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { gatherChapterPlanningContext, buildChapterPlanningRecap } from '@/lib/ai/planContext';
import { buildChapterOutlinePrompt, CHAPTER_OUTLINE_SCHEMA, type ChapterOutlineResult } from '@/lib/ai/prompts/plan';
import { callOpenAIStructured } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

// Produces the Detailed Chapter Outline and persists it as a NEW version —
// chapter_outlines is versioned (is_current + partial unique index), so
// "Plan This Chapter" the first time and "Update Outline" later both land
// here and both just create version N+1. The previous version is never
// edited or deleted, only superseded.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { interviewId } = (await request.json()) as { interviewId: string };

  const { data: interview } = await supabase.from('ai_interviews').select('*').eq('id', interviewId).single();
  if (!interview || !interview.chapter_id) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

  const { data: history } = await supabase
    .from('ai_interview_messages')
    .select('*')
    .eq('interview_id', interviewId)
    .order('created_at', { ascending: true });

  try {
    const ctx = await gatherChapterPlanningContext(supabase, { bookId: interview.book_id, chapterId: interview.chapter_id });
    const recap = buildChapterPlanningRecap(ctx);

    const prompt = buildChapterOutlinePrompt(recap, history ?? []);
    const result = await callOpenAIStructured<ChapterOutlineResult>({
      ...prompt,
      toolName: 'build_chapter_outline',
      toolDescription: 'Return the Detailed Chapter Outline.',
      schema: CHAPTER_OUTLINE_SCHEMA,
      maxTokens: 8000,
      meta: { supabase, feature: 'plan_chapter_finish', bookId: interview.book_id }
    });

    const { data: priorCurrent } = await supabase
      .from('chapter_outlines')
      .select('version_number')
      .eq('chapter_id', interview.chapter_id)
      .eq('is_current', true)
      .maybeSingle();
    if (priorCurrent) {
      await supabase.from('chapter_outlines').update({ is_current: false }).eq('chapter_id', interview.chapter_id).eq('is_current', true);
    }

    // open_questions are phrased as questions, never declarations (see the
    // prompt) — folded into continuity_notes as their own labeled block
    // rather than a new column, since they're read the same way.
    const continuityNotes = [result.continuity_notes, result.open_questions?.length ? `Open questions:\n${result.open_questions.map((q) => `- ${q}`).join('\n')}` : null]
      .filter(Boolean)
      .join('\n\n');

    const { data: newOutline, error: outlineError } = await supabase
      .from('chapter_outlines')
      .insert({
        chapter_id: interview.chapter_id,
        version_number: (priorCurrent?.version_number ?? 0) + 1,
        is_current: true,
        purpose: result.purpose,
        opening_state: result.opening_state ?? null,
        chapter_end_state: result.chapter_end_state ?? null,
        new_questions_created: result.new_questions_created ?? null,
        continuity_notes: continuityNotes || null,
        created_by: user.id
      })
      .select()
      .single();
    if (outlineError || !newOutline) throw outlineError;

    const scenes = [];
    let sceneSortOrder = 0;
    for (const scene of result.scenes) {
      const { data: sceneRow, error: sceneError } = await supabase
        .from('chapter_outline_scenes')
        .insert({
          chapter_outline_id: newOutline.id,
          title: scene.title,
          goal: scene.goal ?? null,
          sort_order: sceneSortOrder++
        })
        .select()
        .single();
      if (sceneError || !sceneRow) throw sceneError;

      let beatSortOrder = 0;
      const beatRows = [];
      for (const beatText of scene.beats) {
        const { data: beatRow, error: beatError } = await supabase
          .from('outline_beats')
          .insert({ chapter_outline_scene_id: sceneRow.id, text: beatText, sort_order: beatSortOrder++ })
          .select()
          .single();
        if (beatError || !beatRow) throw beatError;
        beatRows.push(beatRow);
      }
      scenes.push({ ...sceneRow, beats: beatRows });
    }

    await supabase.from('ai_interviews').update({ status: 'complete', chapter_outline_id: newOutline.id }).eq('id', interviewId);

    return NextResponse.json({ outline: newOutline, scenes });
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/plan/chapter/finish failed', err);
    return NextResponse.json({ error: 'Could not build the chapter outline — your interview answers are still saved, try again.' }, { status: 502 });
  }
}
