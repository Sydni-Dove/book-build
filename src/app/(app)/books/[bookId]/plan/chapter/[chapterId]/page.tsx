'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useBook } from '@/components/layout/BookContext';
import { Button, Card, Textarea } from '@/components/ui';
import type { ChapterOutline, ChapterOutlineScene, OutlineBeat } from '@/lib/types/database';
import type { RecapSection } from '@/lib/ai/planContext';

type Turn = { role: 'assistant' | 'author'; text: string };
type SceneWithBeats = ChapterOutlineScene & { beats: OutlineBeat[] };
type Stage = 'loading' | 'recap' | 'interview' | 'outline';

// PLAN's chapter-level page — recap ("Where We Are Now") → Plan This
// Chapter interview → Detailed Chapter Outline with a Beat-by-Beat editor
// (Move Up/Down, never drag-and-drop) → Start Writing handoff. "Update
// Outline" re-enters the same interview, which always lands as a NEW
// chapter_outlines version — the previous one is never edited in place.
export default function PlanChapterPage() {
  const { book, chapters } = useBook();
  const params = useParams<{ chapterId: string }>();
  const supabase = createClient();
  const router = useRouter();
  const chapterId = params.chapterId;
  const chapterFromContext = chapters.find((c) => c.id === chapterId);

  const [chapterTitle, setChapterTitle] = useState<string | null>(chapterFromContext?.title ?? null);
  const [stage, setStage] = useState<Stage>('loading');
  const [recap, setRecap] = useState<RecapSection[]>([]);
  const [outline, setOutline] = useState<ChapterOutline | null>(null);
  const [scenes, setScenes] = useState<SceneWithBeats[]>([]);

  const [seedIdea, setSeedIdea] = useState('');
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState('');
  const [sufficient, setSufficient] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    if (chapterFromContext) {
      setChapterTitle(chapterFromContext.title);
      return;
    }
    // Covers the moment right after "Plan this chapter" materializes a
    // brand-new chapter from the Book Outline — BookShell's chapter list
    // hasn't refetched yet when this page first mounts.
    supabase
      .from('chapters')
      .select('title')
      .eq('id', chapterId)
      .single()
      .then(({ data }) => {
        if (data) setChapterTitle(data.title);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, chapterFromContext]);

  async function loadRecap() {
    const res = await fetch('/api/ai/plan/chapter/recap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, chapterId })
    });
    if (res.ok) {
      const data = await res.json();
      setRecap(data.recap);
    }
    setStage('recap');
  }

  async function loadOutline() {
    const { data: current } = await supabase
      .from('chapter_outlines')
      .select('*')
      .eq('chapter_id', chapterId)
      .eq('is_current', true)
      .maybeSingle();
    if (!current) {
      await loadRecap();
      return;
    }
    const { data: sceneRows } = await supabase
      .from('chapter_outline_scenes')
      .select('*')
      .eq('chapter_outline_id', current.id)
      .order('sort_order', { ascending: true });
    const withBeats = await Promise.all(
      (sceneRows ?? []).map(async (scene) => {
        const { data: beats } = await supabase
          .from('outline_beats')
          .select('*')
          .eq('chapter_outline_scene_id', scene.id)
          .order('sort_order', { ascending: true });
        return { ...scene, beats: beats ?? [] };
      })
    );
    setOutline(current);
    setScenes(withBeats);
    setStage('outline');
  }

  useEffect(() => {
    loadOutline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId]);

  async function startInterview() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/plan/chapter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: book.id, chapterId, seedIdea: seedIdea || undefined })
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
      const res = await fetch('/api/ai/plan/chapter', {
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

  async function finishOutline() {
    if (!interviewId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/plan/chapter/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewId })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await loadOutline();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  // Working Notes vs Author Canon — same gate as everywhere else in the
  // app: nothing from this interview reaches canon_facts without this
  // explicit action, and the author chooses which shelf it lands on.
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

  // Beat reordering swaps sort_order between the two adjacent rows — same
  // pattern the chapter list already uses for reordering chapters. No
  // drag-and-drop anywhere, by design (mobile requirement).
  function moveBeat(sceneIndex: number, beatIndex: number, direction: -1 | 1) {
    const scene = scenes[sceneIndex];
    const targetIndex = beatIndex + direction;
    if (!scene || targetIndex < 0 || targetIndex >= scene.beats.length) return;
    const a = scene.beats[beatIndex];
    const b = scene.beats[targetIndex];
    if (!a || !b) return;
    const nextBeats = [...scene.beats];
    nextBeats[beatIndex] = { ...b, sort_order: a.sort_order };
    nextBeats[targetIndex] = { ...a, sort_order: b.sort_order };
    nextBeats.sort((x, y) => x.sort_order - y.sort_order);
    setScenes((s) => s.map((sc, i) => (i === sceneIndex ? { ...sc, beats: nextBeats } : sc)));
    supabase.from('outline_beats').update({ sort_order: a.sort_order }).eq('id', b.id);
    supabase.from('outline_beats').update({ sort_order: b.sort_order }).eq('id', a.id);
  }

  function editBeatText(sceneIndex: number, beatId: string, text: string) {
    setScenes((s) => s.map((sc, i) => (i === sceneIndex ? { ...sc, beats: sc.beats.map((b) => (b.id === beatId ? { ...b, text } : b)) } : sc)));
  }

  async function saveBeatText(beatId: string, text: string) {
    await supabase.from('outline_beats').update({ text }).eq('id', beatId);
  }

  async function addBeat(sceneIndex: number) {
    const scene = scenes[sceneIndex];
    if (!scene) return;
    const nextOrder = (scene.beats[scene.beats.length - 1]?.sort_order ?? -1) + 1;
    const { data } = await supabase
      .from('outline_beats')
      .insert({ chapter_outline_scene_id: scene.id, text: '', sort_order: nextOrder })
      .select()
      .single();
    if (data) setScenes((s) => s.map((sc, i) => (i === sceneIndex ? { ...sc, beats: [...sc.beats, data] } : sc)));
  }

  async function removeBeat(sceneIndex: number, beatId: string) {
    await supabase.from('outline_beats').delete().eq('id', beatId);
    setScenes((s) => s.map((sc, i) => (i === sceneIndex ? { ...sc, beats: sc.beats.filter((b) => b.id !== beatId) } : sc)));
  }

  if (chapterTitle === null || stage === 'loading') return <div className="px-5 py-8 text-sm text-ink-faint">Loading…</div>;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-7 lg:px-10">
      <button
        onClick={() => router.push(`/books/${book.id}/plan`)}
        className="mb-3 text-xs font-medium text-ink-faint hover:text-accent-strong"
      >
        ← Book Outline
      </button>
      <p className="mb-1 font-display text-2xl text-ink">Plan: {chapterTitle}</p>

      {error && <p className="mb-4 text-sm text-critical">{error}</p>}

      {stage === 'recap' && (
        <div className="space-y-4">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Where We Are Now</p>
          <div className="space-y-3">
            {recap.map((s, i) => (
              <div key={i} className="border-l-2 border-line-strong py-px pl-3.5">
                <span className="mb-0.5 block text-[10px] font-extrabold uppercase tracking-wider text-ink-faint">{s.label}</span>
                <span className="whitespace-pre-wrap text-[14.5px] leading-snug text-ink-soft">{s.text}</span>
              </div>
            ))}
          </div>
          <Card className="space-y-3">
            <p className="text-sm text-ink-soft">Anything specific you want this chapter to do? (Optional — I'll ask if not.)</p>
            <Textarea value={seedIdea} onChange={(e) => setSeedIdea(e.target.value)} rows={3} placeholder="Leave blank to let the interview find it…" />
            <Button onClick={startInterview} disabled={loading} className="w-full">
              {loading ? 'Thinking…' : 'Plan This Chapter'}
            </Button>
          </Card>
        </div>
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
              There's enough established for a Detailed Chapter Outline.
              <Button onClick={finishOutline} disabled={loading} className="mt-2 w-full">
                {loading ? 'Building outline…' : 'Build Detailed Outline'}
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
            <p className="text-xs text-ink-faint">Bank what's been established so far:</p>
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

      {stage === 'outline' && outline && (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Detailed Chapter Outline · v{outline.version_number}</p>
            <button
              onClick={() => {
                setInterviewId(null);
                setTurns([]);
                loadRecap();
              }}
              className="shrink-0 text-xs font-medium text-accent-strong hover:underline"
            >
              Update Outline
            </button>
          </div>

          <Card className="space-y-2.5">
            {outline.purpose && (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Purpose</p>
                <p className="text-sm text-ink">{outline.purpose}</p>
              </div>
            )}
            {outline.opening_state && (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Opens</p>
                <p className="text-sm text-ink-soft">{outline.opening_state}</p>
              </div>
            )}
            {outline.chapter_end_state && (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Ends</p>
                <p className="text-sm text-ink-soft">{outline.chapter_end_state}</p>
              </div>
            )}
            {outline.continuity_notes && (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Continuity notes</p>
                <p className="whitespace-pre-wrap text-sm text-ink-soft">{outline.continuity_notes}</p>
              </div>
            )}
          </Card>

          {scenes.map((scene, sceneIndex) => (
            <Card key={scene.id}>
              <p className="font-display text-lg text-ink">{scene.title}</p>
              {scene.goal && <p className="mt-0.5 text-sm text-ink-soft">{scene.goal}</p>}
              <div className="mt-3 space-y-2 border-t border-line pt-3">
                {scene.beats.map((beat, beatIndex) => (
                  <div key={beat.id} className="flex items-start gap-2 rounded-md bg-paper-sunken px-3 py-2">
                    <div className="flex flex-col pt-1">
                      <button
                        onClick={() => moveBeat(sceneIndex, beatIndex, -1)}
                        disabled={beatIndex === 0}
                        className="min-h-[22px] min-w-[22px] px-1 text-ink-faint hover:text-accent-strong disabled:opacity-30"
                        aria-label="Move beat up"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => moveBeat(sceneIndex, beatIndex, 1)}
                        disabled={beatIndex === scene.beats.length - 1}
                        className="min-h-[22px] min-w-[22px] px-1 text-ink-faint hover:text-accent-strong disabled:opacity-30"
                        aria-label="Move beat down"
                      >
                        ▼
                      </button>
                    </div>
                    <textarea
                      value={beat.text}
                      onChange={(e) => editBeatText(sceneIndex, beat.id, e.target.value)}
                      onBlur={(e) => saveBeatText(beat.id, e.target.value)}
                      rows={2}
                      className="min-w-0 flex-1 resize-none rounded-md border border-line bg-white px-2.5 py-1.5 text-base text-ink outline-none focus:border-accent"
                    />
                    <button
                      onClick={() => removeBeat(sceneIndex, beat.id)}
                      className="min-h-[36px] min-w-[36px] px-1 text-ink-faint hover:text-critical"
                      aria-label="Remove beat"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button onClick={() => addBeat(sceneIndex)} className="text-xs font-medium text-accent-strong hover:underline">
                  + Add beat
                </button>
              </div>
            </Card>
          ))}

          <Button onClick={() => router.push(`/books/${book.id}/chapters/${chapterId}`)} className="w-full">
            Start Writing →
          </Button>
        </div>
      )}
    </div>
  );
}
