'use client';

import { useCallback, useEffect, useState } from 'react';
import { useBook } from '@/components/layout/BookContext';
import { Button } from '@/components/ui';
import { FindingCard } from '@/components/review/FindingCard';
import type { ReviewFinding, ReviewFindingStatus } from '@/lib/types/database';

type Summary = { worth_checking: number; likely_conflict: number; open_question: number; open_threads: number; relationships: number; total_attention: number; resolved: number; intentional: number };

const FILTERS: { key: string; label: string; match: (f: ReviewFinding) => boolean }[] = [
  { key: 'all', label: 'All', match: (f) => f.status === 'open' || f.status === 'watch' },
  { key: 'continuity', label: 'Continuity', match: (f) => (f.status === 'open' || f.status === 'watch') && ['continuity', 'character', 'naming', 'knowledge'].includes(f.finding_type) },
  { key: 'storylines', label: 'Storylines', match: (f) => (f.status === 'open' || f.status === 'watch') && ['plot_thread', 'setup_payoff', 'writer_question'].includes(f.finding_type) },
  { key: 'relationships', label: 'Relationships', match: (f) => (f.status === 'open' || f.status === 'watch') && f.finding_type === 'relationship' },
  { key: 'timeline', label: 'Timeline', match: (f) => (f.status === 'open' || f.status === 'watch') && f.finding_type === 'timeline' },
  { key: 'resolved', label: 'Resolved & intentional', match: (f) => f.status === 'resolved' || f.status === 'intentional' }
];

export default function ReviewPage() {
  const { book } = useBook();
  const [findings, setFindings] = useState<ReviewFinding[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState('all');
  const [running, setRunning] = useState(false);
  const [deep, setDeep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiFailed, setAiFailed] = useState(false);
  const [ranOnce, setRanOnce] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/books/review/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: book.id }) });
    const j = await res.json();
    if (j.status === 'ok') { setFindings(j.findings as ReviewFinding[]); setSummary(j.summary as Summary); }
    else setError('Could not load review.');
  }, [book.id]);
  useEffect(() => { load(); }, [load]);

  async function run() {
    setRunning(true); setError(null); setAiFailed(false);
    try {
      const res = await fetch('/api/books/review/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: book.id, deep }) });
      const j = await res.json();
      if (j.status === 'ok') { setFindings(j.findings as ReviewFinding[]); setSummary(j.summary as Summary); setRanOnce(true); if (j.ai_failed) setAiFailed(true); }
      else setError('Review could not run. Please try again.');
    } catch { setError('Review could not run. Please try again.'); }
    finally { setRunning(false); }
  }
  async function setStatus(id: string, status: ReviewFindingStatus) {
    try { await fetch('/api/books/review/finding-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: book.id, finding_id: id, status }) }); await load(); }
    catch { setError('Could not update that finding.'); }
  }

  const activeFilter = FILTERS.find((f) => f.key === filter)!;
  const shown = (findings ?? []).filter(activeFilter.match);
  const attention = summary?.total_attention ?? 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-7 lg:px-10">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <p className="font-display text-2xl text-ink">Review &amp; Continuity</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-soft"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="h-4 w-4 rounded border-line-strong" /> Include deeper AI check</label>
          <Button onClick={run} disabled={running}>{running ? (deep ? 'Reviewing (deep)…' : 'Reviewing…') : ranOnce || attention ? 'Run review again' : 'Run review'}</Button>
        </div>
      </div>
      <p className="mb-5 text-sm text-ink-soft">What's worth knowing before you keep writing or revising — story consistency, not spelling. Nothing here changes your manuscript. The deeper AI check finds subtler issues and takes a moment.</p>

      {error && <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}
      {aiFailed && <div className="mb-4 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">Deep review couldn't finish. Your standard review is still available below.</div>}

      {summary && attention > 0 && (
        <div className="mb-5 flex flex-wrap gap-x-5 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
          {summary.likely_conflict > 0 && <span><b className="text-ink">{summary.likely_conflict}</b> likely conflict{summary.likely_conflict > 1 ? 's' : ''}</span>}
          {summary.worth_checking > 0 && <span><b className="text-ink">{summary.worth_checking}</b> worth checking</span>}
          {summary.open_threads > 0 && <span><b className="text-ink">{summary.open_threads}</b> open storyline{summary.open_threads > 1 ? 's' : ''}</span>}
          {summary.relationships > 0 && <span><b className="text-ink">{summary.relationships}</b> relationship{summary.relationships > 1 ? 's' : ''} to revisit</span>}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => { const n = (findings ?? []).filter(f.match).length; return (
          <button key={f.key} onClick={() => setFilter(f.key)} className={`min-h-[36px] rounded-lg px-3 text-xs font-medium transition ${filter === f.key ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-black/5'}`}>{f.label}{n ? ` (${n})` : ''}</button>
        ); })}
      </div>

      {findings === null && <p className="py-10 text-center text-sm text-ink-faint">Loading…</p>}
      {findings !== null && findings.length === 0 && (
        <div className="rounded-xl border border-line bg-paper px-4 py-12 text-center">
          <p className="font-display text-lg text-ink">{ranOnce ? 'Nothing major is standing out right now.' : 'Run a review to check your story for continuity.'}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">{ranOnce ? 'Your story may still have open threads, but none currently look inconsistent.' : 'It looks for unresolved storylines, setup without payoff, possible conflicts, and things worth revisiting — with evidence you can jump to.'}</p>
        </div>
      )}
      {findings !== null && findings.length > 0 && shown.length === 0 && (
        <p className="rounded-xl border border-line bg-paper px-4 py-8 text-center text-sm text-ink-soft">Nothing in this view. Try “All”.</p>
      )}

      <ul className="space-y-3">
        {shown.map((f) => <FindingCard key={f.id} f={f} bookId={book.id} onStatus={setStatus} />)}
      </ul>
    </div>
  );
}
