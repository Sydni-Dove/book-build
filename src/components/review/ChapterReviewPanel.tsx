'use client';

/**
 * Per-chapter Review & Continuity panel. Runs the SAME review pipeline as the
 * book-level page (`/api/books/review/run` with a `chapter_id`, so findings are
 * scoped to this chapter) and lists the results with the shared FindingCard.
 * `family` splits the two chapter tabs:
 *   - 'continuity' → continuity/character/naming/knowledge/timeline/repetition
 *   - 'review'     → open storylines, setup/payoff, relationships, story questions
 * No new backend, no new analysis system — this is the existing engine, scoped.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { FindingCard, CONTINUITY_TYPES, REVIEW_TYPES } from '@/components/review/FindingCard';
import type { ReviewFinding, ReviewFindingStatus } from '@/lib/types/database';

const COPY = {
  continuity: {
    title: 'Continuity Check',
    blurb: 'Checks this chapter against your Story Canon and the rest of the book — knowledge, timeline, naming, and character consistency. Nothing here changes your manuscript.',
    empty: 'No continuity issues stood out in this chapter.',
    hint: 'It compares this chapter against established facts, character knowledge, and the timeline — with evidence you can jump to.'
  },
  review: {
    title: 'Review Section',
    blurb: 'Reviews this chapter for open storylines, setups waiting to pay off, relationships to revisit, and story questions. Nothing here changes your manuscript.',
    empty: 'Nothing major is standing out in this chapter right now.',
    hint: 'It looks for unresolved threads, setup without payoff, and relationships worth revisiting — with evidence you can jump to.'
  }
} as const;

export function ChapterReviewPanel({ bookId, chapterId, family }: { bookId: string; chapterId: string; family: 'continuity' | 'review' }) {
  const [findings, setFindings] = useState<ReviewFinding[] | null>(null);
  const [running, setRunning] = useState(false);
  const [deep, setDeep] = useState(false);
  const [ranOnce, setRanOnce] = useState(false);
  const [aiFailed, setAiFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const types = family === 'continuity' ? CONTINUITY_TYPES : REVIEW_TYPES;
  const copy = COPY[family];

  // A finding belongs to THIS chapter if it is anchored here or cites it in evidence.
  const inChapter = useCallback((f: ReviewFinding) =>
    (f.chapter_id === chapterId || f.evidence.some((e) => e.chapter_id === chapterId)), [chapterId]);
  const keep = useCallback((rows: ReviewFinding[]) =>
    rows.filter((f) => inChapter(f) && types.includes(f.finding_type) && (f.status === 'open' || f.status === 'watch')), [inChapter, types]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/books/review/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bookId }) });
      const j = await res.json();
      if (j.status === 'ok') setFindings(keep(j.findings as ReviewFinding[]));
      else setError('Could not load review.');
    } catch { setError('Could not load review.'); }
  }, [bookId, keep]);
  useEffect(() => { load(); }, [load]);

  async function run() {
    setRunning(true); setError(null); setAiFailed(false);
    try {
      const res = await fetch('/api/books/review/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, deep }) });
      const j = await res.json();
      if (j.status === 'ok') { setFindings(keep(j.findings as ReviewFinding[])); setRanOnce(true); if (j.ai_failed) setAiFailed(true); }
      else setError('Review could not run. Please try again.');
    } catch { setError('Review could not run. Please try again.'); }
    finally { setRunning(false); }
  }
  async function setStatus(id: string, status: ReviewFindingStatus) {
    try { await fetch('/api/books/review/finding-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bookId, finding_id: id, status }) }); await load(); }
    catch { setError('Could not update that finding.'); }
  }

  const shown = findings ?? [];
  return (
    <div className="space-y-4">
      <div>
        <p className="font-display text-base text-ink">{copy.title}</p>
        <p className="mt-1 text-sm leading-6 text-ink-soft">{copy.blurb}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={running}>{running ? (deep ? 'Reviewing (deep)…' : 'Reviewing…') : ranOnce || shown.length ? 'Run again' : 'Run review'}</Button>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="h-4 w-4 rounded border-line-strong" /> Include deeper AI check</label>
      </div>

      {error && <div className="rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}
      {aiFailed && <div className="rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">Deep review couldn&apos;t finish. Your standard review is still shown below.</div>}

      {findings === null ? (
        <p className="py-6 text-center text-sm text-ink-faint">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-line bg-paper px-4 py-8 text-center">
          <p className="font-display text-base text-ink">{ranOnce ? copy.empty : 'Run a review to check this chapter.'}</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-soft">{copy.hint}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((f) => <FindingCard key={f.id} f={f} bookId={bookId} onStatus={setStatus} />)}
        </ul>
      )}
    </div>
  );
}
