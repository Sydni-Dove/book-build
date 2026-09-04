'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useBook } from '@/components/layout/BookContext';
import { Button, Card, Textarea } from '@/components/ui';
import type { StoryOutline, StoryOutlineNode } from '@/lib/types/database';
import type { PlotPossibility } from '@/lib/ai/prompts/plan';

type Turn = { role: 'assistant' | 'author'; text: string };
type ActNode = StoryOutlineNode & { chapters: StoryOutlineNode[] };
type Stage = 'loading' | 'start' | 'interview' | 'possibilities' | 'outline';

// PLAN's book-level home — "Build My Story," Plot Possibilities, and the
// Book Outline once one exists. Layer boundary: everything here writes to
// story_outlines / story_outline_nodes (what is planned), never to
// canon_facts automatically and never to chapters/writing_sections except
// the one deliberate "Plan this chapter" materialization step below.
export default function PlanPage() {
  const { book, chapters } = useBook();
  const supabase = createClient();
  const router = useRouter();

  const [stage, setStage] = useState<Stage>('loading');
  const [outline, setOutline] = useState<StoryOutline | null>(null);
  const [acts, setActs] = useState<ActNode[]>([]);

  const [seedIdea, setSeedIdea] = useState('');
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState('');
  const [sufficient, setSufficient] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [possibilities, setPossibilities] = useState<PlotPossibility[] | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  async function loadOutline() {
    const { data: current } = await supabase
      .from('story_outlines')
      .select('*')
      .eq('book_id', book.id)
      .eq('is_current', true)
      .maybeSingle();
    if (!current) {
      setStage('start');
      return;
    }
    const { data: nodes } = await supabase
      .from('story_outline_nodes')
      .select('*')
      .eq('story_outline_id', current.id)
      .order('sort_order', { ascending: true });
    const actNodes = (nodes ?? []).filter((n) => n.node_type === 'act');
    const chapterNodes = (nodes ?? []).filter((n) => n.node_type === 'chapter');
    setOutline(current);
    setActs(actNodes.map((a) => ({ ...a, chapters: chapterNodes.filter((c) => c.parent_node_id === a.id) })));
    setStage('outline');
  }

  useEffect(() => {
    loadOutline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  async function startInterview() {
    if (!seedIdea.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/plan/new-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: book.id, seedIdea })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setInterviewId(data.interviewId);
      setTurns([{ role: 'assistant', text: data.question }]);
      setSufficient(data.sufficient);
      setStage('interview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function sendAnswer() {
    if (!answer.trim() || !interviewId) return;
    setLoading(true);
    setError(null);
    const authorText = answer;
    setTurns((t) => [...t, { role: 'author', text: authorText }]);
    setAnswer('');
    try {
      const res = await fetch('/api/ai/plan/new-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewId, authorAnswer: authorText })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setTurns((t) => [...t, { role: 'assistant', text: data.question }]);
      setSufficient(data.sufficient);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function getPossibilities() {
    if (!interviewId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/plan/new-book/possibilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewId })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setPossibilities(data.possibilities);
      setStage('possibilities');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function choose(possibility: PlotPossibility) {
    if (!interviewId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/plan/new-book/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewId, chosenPossibility: possibility })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await loadOutline();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  // Working Notes vs Author Canon — the interview surfaces real facts about
  // the story before any of it is written; the author decides, per answer
  // pair, whether that's settled enough to promote. Nothing here is ever
  // written to canon_facts without this explicit action.
  async function persistNotes(canonStatus: 'working_note' | 'author_canon') {
    if (!interviewId) return;
    setSaveState('saving');
    const pairs: { q: string; a: string }[] = [];
    for (let i = 0; i < turns.length - 1; i++) {
      const q = turns[i];
      const a = turns[i + 1];
      if (q?.role === 'assistant' && a?.role === 'author') {
        pairs.push({ q: q.text, a: a.text });
      }
    }
    if (pairs.length) {
      await supabase.from('canon_facts').insert(
        pairs.map(({ q, a }) => ({
          book_id: book.id,
          fact_type: 'plan_interview_answer',
          subject_type: 'general' as const,
          fact: `${q} — ${a}`,
          source_type: 'interview_answer' as const,
          source_id: interviewId,
          canon_status: canonStatus
        }))
      );
    }
    setSaveState('saved');
  }

  async function planThisChapter(chapterNode: StoryOutlineNode) {
    if (chapterNode.chapter_id) {
      router.push(`/books/${book.id}/plan/chapter/${chapterNode.chapter_id}`);
      return;
    }
    const nextOrder = (chapters[chapters.length - 1]?.sort_order ?? -1) + 1;
    const nextNumber = (chapters[chapters.length - 1]?.chapter_number ?? chapters.length) + 1;
    const { data: newChapter } = await supabase
      .from('chapters')
      .insert({ book_id: book.id, title: chapterNode.title, chapter_number: nextNumber, sort_order: nextOrder })
      .select()
      .single();
    if (!newChapter) return;
    await supabase.from('story_outline_nodes').update({ chapter_id: newChapter.id }).eq('id', chapterNode.id);
    router.refresh();
    router.push(`/books/${book.id}/plan/chapter/${newChapter.id}`);
  }

  if (stage === 'loading') return <div className="px-5 py-8 text-sm text-ink-faint">Loading…</div>;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-7 lg:px-10">
      <p className="mb-1 font-display text-2xl text-ink">Plan</p>
      <p className="mb-6 text-sm text-ink-soft">
        PLAN is upstream of writing — it decides what should happen. Nothing here becomes Story Canon until you say so.
      </p>

      {error && <p className="mb-4 text-sm text-critical">{error}</p>}

      {stage === 'start' && (
        <Card className="space-y-3">
          <p className="font-display text-lg text-ink">Build My Story</p>
          <p className="text-sm text-ink-soft">
            Give me a starting idea — however rough — and I'll ask one question at a time to help shape it into a real outline.
          </p>
          <Textarea
            value={seedIdea}
            onChange={(e) => setSeedIdea(e.target.value)}
            rows={4}
            placeholder="e.g. A woman who hears from God more clearly than anyone she knows, but can't get anyone to believe her…"
          />
          <Button onClick={startInterview} disabled={loading || !seedIdea.trim()} className="w-full">
            {loading ? 'Thinking…' : 'Build My Story'}
          </Button>
        </Card>
      )}

      {stage === 'interview' && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3.5">
            {turns.map((t, i) => (
              <div key={i} className={`border-l-2 py-px pl-3.5 ${t.role === 'assistant' ? 'border-accent' : 'border-gold'}`}>
                <span
                  className={`mb-0.5 block text-[10px] font-extrabold uppercase tracking-wider ${
                    t.role === 'assistant' ? 'text-accent-strong' : 'text-gold-strong'
                  }`}
                >
                  {t.role === 'assistant' ? 'Editor' : 'You'}
                </span>
                <span className={`text-[14.5px] leading-snug ${t.role === 'assistant' ? 'font-medium text-ink' : 'text-ink-soft'}`}>{t.text}</span>
              </div>
            ))}
          </div>

          {sufficient && (
            <div className="rounded-md bg-confirmed-soft px-3 py-2.5 text-xs text-ink">
              There's enough established to see some real directions.
              <Button onClick={getPossibilities} disabled={loading} className="mt-2 w-full">
                {loading ? 'Thinking…' : 'Give Me Plot Possibilities'}
              </Button>
            </div>
          )}

          <div className="space-y-2 border-t border-line pt-3">
            <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder="Your answer…" />
            <Button onClick={sendAnswer} disabled={loading || !answer.trim()} className="w-full">
              {loading ? '…' : 'Answer'}
            </Button>
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <p className="text-xs text-ink-faint">Bank what's been established so far, before you go further:</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => persistNotes('working_note')} disabled={saveState === 'saving'} className="flex-1">
                Save as Working Notes
              </Button>
              <Button onClick={() => persistNotes('author_canon')} disabled={saveState === 'saving'} className="flex-1">
                Add to Story Canon
              </Button>
            </div>
            {saveState === 'saved' && <p className="text-center text-xs text-good">Saved.</p>}
          </div>
        </div>
      )}

      {stage === 'possibilities' && possibilities && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-soft">
            {possibilities.length} genuinely different directions — none of these is canon until you choose one.
          </p>
          {possibilities.map((p, i) => (
            <Card key={i} className="space-y-3">
              <p className="font-display text-lg text-ink">{p.title}</p>
              <p className="text-sm text-ink-soft">{p.premise}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Pros</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink-soft">
                    {p.pros.map((pro, j) => (
                      <li key={j}>{pro}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Cons</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink-soft">
                    {p.cons.map((con, j) => (
                      <li key={j}>{con}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <Button onClick={() => choose(p)} disabled={loading} className="w-full">
                {loading ? 'Building outline…' : 'Choose This Direction'}
              </Button>
            </Card>
          ))}
          <button onClick={() => setStage('interview')} className="text-xs text-ink-faint hover:text-accent-strong">
            ← Keep talking instead
          </button>
        </div>
      )}

      {stage === 'outline' && outline && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">
              {outline.structure_type === 'unstructured' ? 'Unstructured' : outline.structure_type.replace(/_/g, ' ')}
            </p>
            <button onClick={() => setStage('start')} className="text-xs text-ink-faint hover:text-accent-strong">
              Start over
            </button>
          </div>
          {outline.note && <p className="text-sm text-ink-soft">{outline.note}</p>}

          {acts.map((act) => (
            <Card key={act.id}>
              <p className="font-display text-lg text-ink">{act.title}</p>
              {act.purpose && <p className="mt-1 text-sm text-ink-soft">{act.purpose}</p>}
              <div className="mt-3 space-y-2 border-t border-line pt-3">
                {act.chapters.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 rounded-md bg-paper-sunken px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{c.title}</p>
                      {c.purpose && <p className="truncate text-xs text-ink-soft">{c.purpose}</p>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {c.chapter_id && (
                        <button
                          onClick={() => router.push(`/books/${book.id}/chapters/${c.chapter_id}`)}
                          className="text-xs font-medium text-ink-soft hover:text-accent-strong"
                        >
                          Open →
                        </button>
                      )}
                      <button onClick={() => planThisChapter(c)} className="text-xs font-medium text-accent-strong hover:underline">
                        {c.chapter_id ? 'Plan this chapter →' : 'Plan this chapter →'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
