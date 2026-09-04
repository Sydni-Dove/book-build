import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { gatherSectionContext } from '@/lib/ai/context';
import { buildDevelopTurnPrompt, continueDevelopConversation } from '@/lib/ai/prompts/develop';
import { callOpenAIText } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE, toAiFeature } from '@/lib/ai/usage';
import type { WorkingNote } from '@/lib/types/database';

function splitSufficient(raw: string) {
  const sufficient = raw.includes('[SUFFICIENT]');
  const question = raw.replace('[SUFFICIENT]', '').trim();
  return { question, sufficient };
}

function workingNoteSeed(note: WorkingNote, fallbackSeed: string) {
  const title = note.title.trim() || 'Untitled note';
  const content = note.content.trim();
  const extra = fallbackSeed.trim();
  return [
    'WORKING / NON-CANONICAL MATERIAL',
    'This is a private Working Note. It is not manuscript prose, not Story Canon, and not an established story fact.',
    'Use it only as speculative material for questions. Do not rewrite the manuscript or treat this as true unless the author confirms it during the interview.',
    '',
    `Note type: ${note.note_type}`,
    `Title: ${title}`,
    content ? `Content:\n${content}` : 'Content: empty',
    extra && extra !== content ? `Additional author prompt:\n${extra}` : ''
  ].filter(Boolean).join('\n');
}

// Starts a new Develop This interview: { bookId, chapterId, sectionId?, seedIdea }
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json();
  // 'help_think_through' (Review page) vs 'development_interview' (Develop This),
  // passed intentionally by the caller; defaults to development_interview.
  const feature = toAiFeature(body.feature, 'development_interview');

  try {
    // Turn: an existing interview continuing with the author's latest answer.
    if (body.interviewId) {
      const { interviewId, authorAnswer } = body as { interviewId: string; authorAnswer: string };

      const { data: interview } = await supabase
        .from('ai_interviews')
        .select('*')
        .eq('id', interviewId)
        .single();
      if (!interview) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

      await supabase
        .from('ai_interview_messages')
        .insert({ interview_id: interviewId, role: 'author', content: authorAnswer });

      const { data: history } = await supabase
        .from('ai_interview_messages')
        .select('*')
        .eq('interview_id', interviewId)
        .order('created_at', { ascending: true });

      const ctx = await gatherSectionContext(supabase, {
        bookId: interview.book_id,
        chapterId: interview.chapter_id!,
        currentSectionId: interview.section_id ?? undefined
      });

      const prompt = continueDevelopConversation(ctx, interview.topic ?? '', history ?? []);
      const raw = await callOpenAIText({ ...prompt, meta: { supabase, feature, bookId: interview.book_id } });
      const { question, sufficient } = splitSufficient(raw);

      await supabase
        .from('ai_interview_messages')
        .insert({ interview_id: interviewId, role: 'assistant', content: question });

      return NextResponse.json({ interviewId, question, sufficient });
    }

    // Start: a brand new interview.
    const { bookId, chapterId, sectionId, seedIdea, workingNoteId } = body as {
      bookId: string;
      chapterId: string;
      sectionId?: string;
      seedIdea: string;
      workingNoteId?: string;
    };

    let effectiveChapterId = chapterId;
    let effectiveSectionId = sectionId;
    let effectiveSeedIdea = seedIdea;
    let effectiveFeature = feature;

    if (workingNoteId) {
      const { data: note } = await supabase
        .from('working_notes')
        .select('*')
        .eq('id', workingNoteId)
        .eq('book_id', bookId)
        .single();
      if (!note) return NextResponse.json({ error: 'Working note not found' }, { status: 404 });
      effectiveChapterId = note.chapter_id ?? chapterId;
      effectiveSectionId = note.section_id ?? sectionId;
      effectiveSeedIdea = workingNoteSeed(note, seedIdea ?? '');
      effectiveFeature = 'working_note_development';
    }

    const { data: interview, error: insertError } = await supabase
      .from('ai_interviews')
      .insert({
        book_id: bookId,
        chapter_id: effectiveChapterId,
        section_id: effectiveSectionId ?? null,
        working_note_id: workingNoteId ?? null,
        interview_type: 'development',
        topic: effectiveSeedIdea,
        status: 'in_progress'
      })
      .select()
      .single();
    if (insertError || !interview) throw insertError;

    const ctx = await gatherSectionContext(supabase, { bookId, chapterId: effectiveChapterId, currentSectionId: effectiveSectionId });
    const prompt = buildDevelopTurnPrompt(ctx, effectiveSeedIdea);
    const raw = await callOpenAIText({ ...prompt, meta: { supabase, feature: effectiveFeature, bookId } });
    const { question, sufficient } = splitSufficient(raw);

    await supabase
      .from('ai_interview_messages')
      .insert({ interview_id: interview.id, role: 'assistant', content: question });

    return NextResponse.json({ interviewId: interview.id, question, sufficient });
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('ai/develop failed', err);
    return NextResponse.json({ error: 'AI request failed. Your answers so far are safe — try again.' }, { status: 502 });
  }
}
