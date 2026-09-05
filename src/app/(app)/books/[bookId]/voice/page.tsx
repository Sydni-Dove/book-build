'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useBook } from '@/components/layout/BookContext';
import { Button } from '@/components/ui';

type Reason = { metric: string; label: string; value: number; baseline: number; delta: number; z: number; direction: 'higher' | 'lower'; text: string };
type Outlier = { chapter_number: number | null; title: string | null; section_id: string; chapter_id: string; score: number; question: string; reasons: Reason[]; examples: string[] };
type Report = {
  status: 'ok' | 'insufficient_text';
  detail?: string;
  compared_count: number;
  section_count: number;
  outliers: Outlier[];
  summary: { consistent: boolean; outlier_count: number; note: string };
};
type Suggestion = { original: string; suggestion: string; note: string };
type PhrasingHit = { pattern: string; sentence: string; chapter_number: number | null; chapter_id: string; section_id: string };
type PhrasingGroup = { key: string; label: string; description: string; tightenable: boolean; count: number; hits: PhrasingHit[] };
type PhrasingReport = { status: 'ok' | 'empty'; total: number; groups: PhrasingGroup[]; note: string };

// A distinctive, single-line slice of a sentence used to locate + highlight it
// on the chapter page. Kept short so it stays within one line of prose.
function findParam(sentence: string): string {
  const s = (sentence ?? '').replace(/…+$/,'').replace(/^["“'']+|["”'']+$/g, '').trim().slice(0, 55).trim();
  return s ? `?find=${encodeURIComponent(s)}` : '';
}

function OutlierCard({ bookId, o }: { bookId: string; o: Outlier }) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function tighten() {
    setBusy(true); setErr(null);
    try {
      const concern = o.reasons.map((r) => r.text).join(' ');
      const res = await fetch('/api/books/voice/revise', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, concern, passages: o.examples })
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.code === 'AI_USAGE_LIMIT_REACHED' ? data.error : 'Could not get suggestions — try again.'); return; }
      setSuggestions((data.suggestions ?? []) as Suggestion[]);
    } catch { setErr('Could not get suggestions — try again.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-display text-base text-ink">
          {o.chapter_number ? `Chapter ${o.chapter_number}` : 'Chapter'}{o.title ? ` · ${o.title}` : ''}
        </p>
        <span className="rounded-md bg-paper-sunken px-2 py-0.5 text-xs text-ink-soft">reads differently</span>
      </div>

      <ul className="mb-3 space-y-1">
        {o.reasons.map((r) => (<li key={r.metric} className="text-sm text-ink">• {r.text}</li>))}
      </ul>

      {o.examples.length > 0 && (
        <div className="mb-3 rounded-lg bg-paper-sunken p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Passages that stand out</p>
          <ul className="space-y-1.5">
            {o.examples.map((ex, i) => (<li key={i} className="text-sm italic text-ink-soft">“{ex}”</li>))}
          </ul>
        </div>
      )}

      <p className="mb-3 text-sm text-ink-soft">{o.question}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/books/${bookId}/chapters/${o.chapter_id}${o.examples[0] ? findParam(o.examples[0]) : ''}`}
          className="rounded-lg bg-accent-strong px-3 py-2 text-xs font-medium text-white transition hover:opacity-90"
        >
          Open chapter →
        </Link>
        {o.examples.length > 0 && (
          <button
            onClick={tighten}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-accent-strong transition hover:border-accent disabled:opacity-60"
          >
            {busy ? 'Thinking…' : suggestions ? 'Suggest again' : '✨ Help me tighten these'}
          </button>
        )}
      </div>

      {err && <p className="mt-2 text-sm text-critical">{err}</p>}

      {suggestions && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <p className="text-xs text-ink-faint">Suggestions only — nothing changes until you edit it in the chapter.</p>
          {suggestions.map((s, i) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <p className="text-sm text-ink-soft"><span className="text-ink-faint">Now:</span> “{s.original}”</p>
              <p className="mt-1 text-sm text-ink"><span className="text-ink-faint">Tighter:</span> “{s.suggestion}”</p>
              {s.note && <p className="mt-1 text-xs text-ink-faint">{s.note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhrasingGroupCard({ bookId, g }: { bookId: string; g: PhrasingGroup }) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function tighten() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/books/voice/revise', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, concern: `Overuse of ${g.label.toLowerCase()}`, passages: g.hits.map((h) => h.sentence).slice(0, 6) })
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.code === 'AI_USAGE_LIMIT_REACHED' ? data.error : 'Could not get suggestions — try again.'); return; }
      setSuggestions((data.suggestions ?? []) as Suggestion[]);
    } catch { setErr('Could not get suggestions — try again.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="font-display text-base text-ink">{g.label}</p>
        <span className="rounded-md bg-paper-sunken px-2 py-0.5 text-xs text-ink-soft">{g.count} spot{g.count === 1 ? '' : 's'}</span>
      </div>
      <p className="mb-3 text-xs text-ink-faint">{g.description}</p>
      <ul className="space-y-2.5">
        {g.hits.map((h, i) => (
          <li key={i}>
            <p className="text-sm italic text-ink-soft">“{h.sentence}”</p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {h.pattern}{' · '}
              <Link href={`/books/${bookId}/chapters/${h.chapter_id}${findParam(h.sentence)}`} className="whitespace-nowrap text-accent-strong hover:underline">
                {h.chapter_number ? `open Chapter ${h.chapter_number} →` : 'open chapter →'}
              </Link>
            </p>
          </li>
        ))}
      </ul>
      {g.tightenable && (
        <button onClick={tighten} disabled={busy} className="mt-3 rounded-lg border border-line px-3 py-2 text-xs font-medium text-accent-strong transition hover:border-accent disabled:opacity-60">
          {busy ? 'Thinking…' : suggestions ? 'Suggest again' : '✨ Help me tighten these'}
        </button>
      )}
      {err && <p className="mt-2 text-sm text-critical">{err}</p>}
      {suggestions && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <p className="text-xs text-ink-faint">Suggestions only — nothing changes until you edit it in the chapter.</p>
          {suggestions.map((s, i) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <p className="text-sm text-ink-soft"><span className="text-ink-faint">Now:</span> “{s.original}”</p>
              <p className="mt-1 text-sm text-ink"><span className="text-ink-faint">Tighter:</span> “{s.suggestion}”</p>
              {s.note && <p className="mt-1 text-xs text-ink-faint">{s.note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function VoicePage() {
  const { book } = useBook();
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrasing, setPhrasing] = useState<PhrasingReport | null>(null);
  const [phrasingRunning, setPhrasingRunning] = useState(false);

  async function runPhrasing() {
    setPhrasingRunning(true);
    try {
      const res = await fetch('/api/books/phrasing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: book.id }) });
      const data = await res.json();
      if (res.ok) setPhrasing(data as PhrasingReport);
    } catch { /* ignore */ }
    finally { setPhrasingRunning(false); }
  }

  async function run() {
    setRunning(true); setError(null);
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
        noticeably different from the rest, shows you the exact passages, and can suggest tighter wording. Nothing here changes your manuscript.
      </p>

      {error && <p className="mb-4 text-sm text-critical">{error}</p>}
      {!report && !running && (<p className="text-sm text-ink-faint">Click “Check my voice” to scan the whole manuscript.</p>)}

      {report && report.status === 'insufficient_text' && (
        <div className="rounded-xl border border-line bg-surface p-5 text-sm text-ink-soft">{report.detail}</div>
      )}

      {report && report.status === 'ok' && (
        <>
          <div className="mb-6 rounded-xl border border-line bg-surface p-5">
            <p className="text-sm text-ink">{report.summary.consistent ? '✓ ' : ''}{report.summary.note}</p>
            <p className="mt-1 text-xs text-ink-faint">Compared {report.compared_count} of {report.section_count} sections (sections under ~120 words are skipped as too short to judge).</p>
          </div>

          {report.outliers.length === 0 ? (
            <p className="text-sm text-ink-faint">No sections stood out. Your voice reads consistently.</p>
          ) : (
            <div className="space-y-4">
              {report.outliers.map((o) => (<OutlierCard key={o.section_id} bookId={book.id} o={o} />))}
            </div>
          )}
        </>
      )}

      {/* Phrasing check — patterns that read generic / overwritten (no AI-detection claim). */}
      <div className="mt-10 border-t border-line pt-8">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-display text-xl text-ink">Phrasing check</h2>
          <Button variant="secondary" onClick={runPhrasing} disabled={phrasingRunning}>
            {phrasingRunning ? 'Checking…' : phrasing ? 'Check again' : 'Check phrasing'}
          </Button>
        </div>
        <p className="mb-6 text-sm text-ink-soft">
          Looks for phrasing that reads generic or overwritten — the “not X, but Y” cadence, significance words (profound, sacred, palpable…), filler, and repeated openers.
          It shows you the actual lines; it does <em>not</em> claim anything is AI-written, and it changes nothing. You decide what’s intentional.
        </p>

        {phrasing && phrasing.status === 'empty' && (<p className="text-sm text-ink-faint">{phrasing.note}</p>)}
        {phrasing && phrasing.status === 'ok' && (
          <>
            <div className="mb-6 rounded-xl border border-line bg-surface p-5"><p className="text-sm text-ink">{phrasing.note}</p></div>
            <div className="space-y-4">
              {phrasing.groups.map((g) => (<PhrasingGroupCard key={g.key} bookId={book.id} g={g} />))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
