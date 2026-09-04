'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useBook } from '@/components/layout/BookContext';
import { Button } from '@/components/ui';

type Reason = { metric: string; label: string; value: number; baseline: number; delta: number; z: number; direction: 'higher' | 'lower'; text: string };
type Outlier = { chapter_number: number | null; title: string | null; section_id: string; chapter_id: string; score: number; question: string; reasons: Reason[] };
type Report = {
  status: 'ok' | 'insufficient_text';
  detail?: string;
  compared_count: number;
  section_count: number;
  outliers: Outlier[];
  summary: { consistent: boolean; outlier_count: number; note: string };
};

export default function VoicePage() {
  const { book } = useBook();
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/books/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: book.id }) });
      const data = await res.json();
      if (!res.ok || data.status === 'NOT_FOUND') { setError('Could not run the voice check — try again.'); return; }
      setReport(data as Report);
    } catch { setError('Could not run the voice check — try again.'); }
    finally { setRunning(false); }
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-7 lg:px-8">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl text-ink">Voice Consistency</h1>
        <Button onClick={run} disabled={running}>{running ? 'Checking…' : report ? 'Check again' : 'Check my voice'}</Button>
      </div>
      <p className="mb-6 text-sm text-ink-soft">
        A read of how consistent your writing voice is across the whole book — sentence length, adverbs, dialogue vs. narration, fragments. It only flags sections that read
        noticeably different from the rest, and asks whether that&apos;s intentional. Nothing here changes your manuscript, and no AI is used.
      </p>

      {error && <p className="mb-4 text-sm text-critical">{error}</p>}

      {!report && !running && (
        <p className="text-sm text-ink-faint">Click “Check my voice” to scan the whole manuscript.</p>
      )}

      {report && report.status === 'insufficient_text' && (
        <div className="rounded-xl border border-line bg-surface p-5 text-sm text-ink-soft">{report.detail}</div>
      )}

      {report && report.status === 'ok' && (
        <>
          <div className="mb-6 rounded-xl border border-line bg-surface p-5">
            <p className="text-sm text-ink">
              {report.summary.consistent ? '✓ ' : ''}{report.summary.note}
            </p>
            <p className="mt-1 text-xs text-ink-faint">Compared {report.compared_count} of {report.section_count} sections (sections under ~120 words are skipped as too short to judge).</p>
          </div>

          {report.outliers.length === 0 ? (
            <p className="text-sm text-ink-faint">No sections stood out. Your voice reads consistently.</p>
          ) : (
            <div className="space-y-4">
              {report.outliers.map((o) => (
                <div key={o.section_id} className="rounded-xl border border-line bg-surface p-5">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Link href={`/books/${book.id}/chapters/${o.chapter_id}`} className="font-display text-base text-accent-strong hover:underline">
                      {o.chapter_number ? `Chapter ${o.chapter_number}` : 'Chapter'}{o.title ? ` · ${o.title}` : ''}
                    </Link>
                    <span className="rounded-md bg-paper-sunken px-2 py-0.5 text-xs text-ink-soft">reads differently</span>
                  </div>
                  <ul className="mb-3 space-y-1">
                    {o.reasons.map((r) => (
                      <li key={r.metric} className="text-sm text-ink">• {r.text}</li>
                    ))}
                  </ul>
                  <p className="text-sm text-ink-soft">{o.question}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
