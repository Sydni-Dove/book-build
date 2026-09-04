'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui';
import type { ContinueQuestion } from '@/lib/ai/prompts/continue';

export function HelpMeContinuePanel({
  bookId,
  chapterId,
  sectionId
}: {
  bookId: string;
  chapterId: string;
  sectionId?: string;
}) {
  const supabase = createClient();
  const [questions, setQuestions] = useState<ContinueQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [showBasis, setShowBasis] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function fetchQuestions() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterId, currentSectionId: sectionId })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
      const data = await res.json();
      setQuestions(data.questions);
      setAnswers({});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function persist(canonStatus: 'working_note' | 'author_canon') {
    if (!questions) return;
    setSaveState('saving');
    const answered = questions
      .map((q, i) => ({ q, a: answers[i]?.trim() }))
      .filter((x): x is { q: ContinueQuestion; a: string } => Boolean(x.a));

    if (answered.length) {
      await supabase.from('canon_facts').insert(
        answered.map(({ q, a }) => ({
          book_id: bookId,
          fact_type: 'pre_writing_answer',
          subject_type: 'general' as const,
          fact: `${q.question} — ${a}`,
          // This is the Help Me Continue / Before You Continue flow itself,
          // as distinct from the Develop This interview ('interview_answer').
          source_type: 'before_you_continue' as const,
          source_id: sectionId ?? null,
          canon_status: canonStatus
        }))
      );

      if (sectionId) {
        const { data: existing } = await supabase
          .from('writing_sections')
          .select('pre_writing_answers')
          .eq('id', sectionId)
          .single();
        const prior = existing?.pre_writing_answers ?? [];
        await supabase
          .from('writing_sections')
          .update({
            pre_writing_answers: [
              ...prior,
              ...answered.map(({ q, a }) => ({ question: q.question, answer: a, basedOn: q.basedOn }))
            ]
          })
          .eq('id', sectionId);
      }
    }
    setSaveState('saved');
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="font-display text-base text-ink">Help Me Continue</p>
        <p className="mt-1 text-sm text-ink-soft">
          Questions built from what's actually in the manuscript so far — answer as many as help.
        </p>
      </div>

      {!questions && (
        <Button onClick={fetchQuestions} disabled={loading} className="w-full">
          {loading ? 'Reading the manuscript…' : 'Get Questions'}
        </Button>
      )}

      {error && <p className="text-sm text-critical">{error}</p>}

      {questions && (
        <div className="space-y-4">
          {questions.map((q, i) => (
            <div key={i} className="border-b border-line pb-3 last:border-none">
              <p className="text-sm font-medium text-ink">{q.question}</p>
              {q.basedOn?.length > 0 && (
                <button
                  onClick={() => setShowBasis((s) => ({ ...s, [i]: !s[i] }))}
                  className="mt-1 text-xs text-accent-strong hover:underline"
                >
                  {showBasis[i] ? 'Hide' : 'Based on'}
                </button>
              )}
              {showBasis[i] && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-faint">
                  {q.basedOn.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              )}
              <textarea
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
                rows={2}
                placeholder="Your answer…"
                className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>
          ))}

          <div className="flex flex-col gap-2">
            <Button variant="secondary" onClick={() => persist('working_note')} disabled={saveState === 'saving'}>
              Save Answers
            </Button>
            <Button onClick={() => persist('author_canon')} disabled={saveState === 'saving'}>
              Add Answers to Canon
            </Button>
            {saveState === 'saved' && <p className="text-center text-xs text-good">Saved.</p>}
          </div>

          <button onClick={fetchQuestions} className="text-xs text-ink-faint hover:text-accent-strong">
            Ask again
          </button>
        </div>
      )}
    </div>
  );
}
