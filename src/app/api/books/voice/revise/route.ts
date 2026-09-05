import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { callOpenAIStructured } from '@/lib/ai/client';
import { isAiUsageLimitError, AI_USAGE_LIMIT_MESSAGE } from '@/lib/ai/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Editorial help for Voice Consistency: given the flagged phrases from a section
// and the way it drifts from the book's voice, suggest tighter, on-voice
// rewrites. These are SUGGESTIONS the writer chooses to use in the editor — the
// manuscript is never changed here. Owner-scoped (RLS) + cost-capped.
const SYSTEM =
  "You are a line editor helping a novelist keep ONE consistent authorial voice. You are given a few sentences that read differently from the rest of the book, and how they differ (e.g. longer sentences, more -ly adverbs, more fragments). For each, offer ONE tighter revision that fixes that specific drift while preserving the author's meaning, imagery, and faith-based tone. Do not invent new events or facts. Keep the author's wording where you can — small, surgical edits, not a rewrite. If a sentence is already fine, return it unchanged and say so.";

const SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { original: { type: 'string' }, suggestion: { type: 'string' }, note: { type: 'string' } },
        required: ['original', 'suggestion', 'note']
      }
    }
  },
  required: ['suggestions']
};

export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await request.json()) as { book_id: string; concern?: string; passages?: string[] };
  // RLS check: the caller must own this book.
  const { data: book } = await supabase.from('books').select('id').eq('id', body.book_id).maybeSingle();
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  const passages = (body.passages ?? []).filter((p) => typeof p === 'string' && p.trim()).slice(0, 6);
  if (passages.length === 0) return NextResponse.json({ error: 'No passages to revise.' }, { status: 400 });

  try {
    const result = await callOpenAIStructured<{ suggestions: { original: string; suggestion: string; note: string }[] }>({
      system: SYSTEM,
      messages: [{ role: 'user', content: `How this passage drifts from the book's voice: ${body.concern || 'reads differently from the rest of the book'}.\n\nSentences to tighten (one suggestion each):\n${passages.map((p, i) => `${i + 1}. ${p}`).join('\n')}` }],
      toolName: 'voice_revisions', toolDescription: 'Tighter, on-voice rewrites for the flagged sentences.',
      schema: SCHEMA, maxTokens: 4000,
      meta: { supabase, feature: 'voice_revision', bookId: body.book_id }
    });
    return NextResponse.json(result);
  } catch (err) {
    if (isAiUsageLimitError(err)) return NextResponse.json({ error: AI_USAGE_LIMIT_MESSAGE, code: 'AI_USAGE_LIMIT_REACHED' }, { status: 429 });
    console.error('voice/revise failed', err);
    return NextResponse.json({ error: 'Could not generate suggestions — try again.' }, { status: 502 });
  }
}
