'use client';

/**
 * Shared Review & Continuity finding card — used by the book-level Review page
 * and the per-chapter Review/Continuity tabs so both render findings, evidence,
 * status actions, "Help me think through it", and "Add to Story Canon"
 * identically. FIND/EXPLAIN/DECIDE only — it never edits prose or canon.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { ReviewFinding, ReviewFindingStatus } from '@/lib/types/database';

export const LEVEL_LABEL: Record<string, string> = { worth_checking: 'Worth checking', likely_conflict: 'Likely conflict', open_question: 'Open story question' };
export const LEVEL_CHIP: Record<string, string> = { worth_checking: 'bg-paper-sunken text-ink-soft', likely_conflict: 'bg-coral-soft text-accent-strong', open_question: 'bg-gold-soft text-gold-strong' };
export const TYPE_LABEL: Record<string, string> = { continuity: 'Continuity', plot_thread: 'Storyline', character: 'Character', relationship: 'Relationship', timeline: 'Timeline', setup_payoff: 'Setup & payoff', repetition: 'Repetition', knowledge: 'Knowledge', naming: 'Naming', writer_question: 'Story question' };
export const STATUS_LABEL: Record<ReviewFindingStatus, string> = { open: 'Needs review', intentional: 'Intentional', resolved: 'Resolved', watch: 'Keep watching' };

// Finding-type families — the two chapter tabs split on these, and the book-level
// page groups on the same sets. Continuity-side vs storyline/relationship-side.
export const CONTINUITY_TYPES = ['continuity', 'character', 'naming', 'knowledge', 'timeline', 'repetition'];
export const REVIEW_TYPES = ['plot_thread', 'setup_payoff', 'relationship', 'writer_question'];

export function FindingCard({ f, bookId, onStatus }: { f: ReviewFinding; bookId: string; onStatus: (id: string, s: ReviewFindingStatus) => void }) {
  const anchor = f.chapter_id ?? f.evidence.find((e) => e.chapter_id)?.chapter_id ?? null;
  const isStoryline = f.finding_type === 'plot_thread' || f.finding_type === 'setup_payoff';
  const [iv, setIv] = useState<{ id?: string; question?: string; answer: string; done: boolean; busy: boolean; err?: string } | null>(null);
  const [canon, setCanon] = useState<{ fact: string; busy: boolean; done: boolean; err?: string } | null>(null);

  async function startThink() {
    if (!anchor) return;
    setIv({ answer: '', done: false, busy: true });
    try {
      const seed = `Continuity review — help me decide about this finding: "${f.title}". ${f.explanation} ${f.question ?? ''} Evidence: ${f.evidence.map((e) => (e.chapter_number ? `Ch ${e.chapter_number}: ` : '') + e.context).join(' | ')}. Help me decide whether it's intentional, needs revision, needs another beat, should resolve later, should become canon, or stay open.`;
      const res = await fetch('/api/ai/develop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId, chapterId: anchor, seedIdea: seed, feature: 'help_think_through' }) });
      const j = await res.json();
      if (j.interviewId) setIv({ id: j.interviewId, question: j.question, answer: '', done: !!j.sufficient, busy: false });
      else setIv({ answer: '', done: false, busy: false, err: 'Could not start. Try again.' });
    } catch { setIv({ answer: '', done: false, busy: false, err: 'Could not start. Try again.' }); }
  }
  async function sendAnswer() {
    if (!iv?.id || !iv.answer.trim()) return;
    setIv({ ...iv, busy: true });
    try {
      const res = await fetch('/api/ai/develop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interviewId: iv.id, authorAnswer: iv.answer, feature: 'help_think_through' }) });
      const j = await res.json();
      setIv({ id: iv.id, question: j.question, answer: '', done: !!j.sufficient, busy: false });
    } catch { setIv({ ...iv, busy: false, err: 'Could not send. Try again.' }); }
  }
  async function propose() {
    if (!canon || !canon.fact.trim()) return;
    setCanon({ ...canon, busy: true });
    try {
      const res = await fetch('/api/books/review/canon-proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bookId, finding_id: f.id, fact: canon.fact }) });
      const j = await res.json();
      if (j.status === 'ok') setCanon({ ...canon, busy: false, done: true });
      else setCanon({ ...canon, busy: false, err: 'Could not create the proposal.' });
    } catch { setCanon({ ...canon, busy: false, err: 'Could not create the proposal.' }); }
  }

  const quiet = f.status === 'resolved' || f.status === 'intentional';
  return (
    <li className={`rounded-xl border bg-surface px-4 py-3 ${quiet ? 'border-line opacity-70' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-paper-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-soft">{TYPE_LABEL[f.finding_type]}</span>
        <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${LEVEL_CHIP[f.level]}`}>{LEVEL_LABEL[f.level]}</span>
        {f.source === 'ai' && <span className="rounded-md border border-accent/30 bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-strong">Deep review</span>}
        {f.status !== 'open' && <span className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-faint">{STATUS_LABEL[f.status]}</span>}
      </div>
      <p className="mt-2 font-display text-base text-ink">{f.title}</p>
      <p className="mt-1 text-sm leading-6 text-ink-soft">{f.explanation}</p>

      {f.evidence.length > 0 && (
        <div className="mt-3 space-y-1 rounded-lg bg-paper px-3 py-2">
          {f.evidence.map((e, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
              {e.chapter_id ? (
                <Link href={`/books/${bookId}/chapters/${e.chapter_id}`} className="shrink-0 font-semibold text-accent-strong hover:underline">{e.chapter_number ? `Chapter ${e.chapter_number}` : 'Chapter'}</Link>
              ) : <span className="shrink-0 font-semibold text-ink-faint">Reference</span>}
              <span className="min-w-0 italic text-ink-faint">“{e.context}”</span>
            </div>
          ))}
        </div>
      )}
      {f.question && <p className="mt-2 text-sm text-ink"><span className="text-ink-faint">Question: </span>{f.question}</p>}

      {/* Guided: Help me think through it (existing development engine) */}
      {iv && (
        <div className="mt-3 rounded-lg border border-accent/30 bg-accent-soft/30 px-3 py-3">
          {iv.err && <p className="text-sm text-accent-strong">{iv.err}</p>}
          {iv.busy && !iv.question && <p className="text-sm text-ink-soft">Thinking…</p>}
          {iv.question && <p className="text-sm leading-6 text-ink">{iv.question}</p>}
          {iv.question && !iv.done && (
            <div className="mt-2">
              <textarea value={iv.answer} onChange={(e) => setIv({ ...iv, answer: e.target.value })} placeholder="Your thoughts…" className="h-20 w-full resize-none rounded-lg border border-line bg-white p-2 text-sm text-ink outline-none focus:border-accent" />
              <div className="mt-2 flex justify-end"><button onClick={sendAnswer} disabled={iv.busy || !iv.answer.trim()} className="min-h-[40px] rounded-lg bg-accent px-4 text-xs font-semibold text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50">{iv.busy ? 'Sending…' : 'Send'}</button></div>
            </div>
          )}
          {iv.done && <p className="mt-2 text-xs text-ink-soft">That's a good place to decide — mark this finding intentional, resolved, or keep watching, and revise the chapter if you choose.</p>}
        </div>
      )}

      {/* Add to Story Canon (proposal only) */}
      {canon && (
        <div className="mt-3 rounded-lg border border-line bg-paper px-3 py-3">
          {canon.done ? (
            <p className="text-sm text-ink-soft">Canon proposal created — review &amp; approve it in <Link href={`/books/${bookId}/story-canon/canon`} className="font-semibold text-accent-strong hover:underline">Story Canon</Link>.</p>
          ) : (
            <>
              <p className="mb-1 text-xs font-semibold text-ink-soft">Proposed fact (edit before proposing):</p>
              <textarea value={canon.fact} onChange={(e) => setCanon({ ...canon, fact: e.target.value })} className="h-16 w-full resize-none rounded-lg border border-line bg-white p-2 text-sm text-ink outline-none focus:border-accent" />
              {canon.err && <p className="mt-1 text-sm text-accent-strong">{canon.err}</p>}
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setCanon(null)} className="min-h-[40px] rounded-lg border border-line px-3 text-xs text-ink-soft">Cancel</button>
                <button onClick={propose} disabled={canon.busy || !canon.fact.trim()} className="min-h-[40px] rounded-lg bg-accent px-4 text-xs font-semibold text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50">{canon.busy ? 'Proposing…' : 'Propose to Canon'}</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {f.status !== 'resolved' && <button onClick={() => onStatus(f.id, 'resolved')} className="min-h-[40px] rounded-lg border border-line px-3 text-xs font-medium text-ink-soft hover:border-accent">Mark resolved</button>}
        {f.status !== 'intentional' && <button onClick={() => onStatus(f.id, 'intentional')} className="min-h-[40px] rounded-lg border border-line px-3 text-xs font-medium text-ink-soft hover:border-accent">Looks intentional</button>}
        {f.status !== 'watch' && f.status !== 'resolved' && <button onClick={() => onStatus(f.id, 'watch')} className="min-h-[40px] rounded-lg border border-line px-3 text-xs font-medium text-ink-soft hover:border-accent">Keep watching</button>}
        {quiet && <button onClick={() => onStatus(f.id, 'open')} className="min-h-[40px] rounded-lg border border-line px-3 text-xs font-medium text-ink-soft hover:border-accent">Reopen</button>}
        {anchor && <button onClick={startThink} className="min-h-[40px] rounded-lg border border-accent/40 px-3 text-xs font-semibold text-accent-strong hover:bg-accent-soft">Help me think through it</button>}
        {!canon && <button onClick={() => setCanon({ fact: f.title.replace(/^Setup to pay off: |^Possible conflict:? ?|^Open storyline: /i, '').replace(/[“”"]/g, '').trim(), busy: false, done: false })} className="min-h-[40px] rounded-lg border border-line px-3 text-xs font-medium text-ink-soft hover:border-accent">Add to Story Canon</button>}
        {anchor && <Link href={`/books/${bookId}/chapters/${anchor}`} className="min-h-[40px] inline-flex items-center rounded-lg bg-accent px-3 text-xs font-semibold text-[#F6F3EC] hover:bg-accent-strong">{isStoryline ? 'Develop this →' : 'Go to evidence →'}</Link>}
      </div>
    </li>
  );
}
