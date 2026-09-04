'use client';

import { useRef, useState } from 'react';
import { SectionVersionDiff } from '@/components/versions/SectionVersionDiff';

type DiffLine = { kind: 'common' | 'removed' | 'added'; text: string };
type Summary = { paragraphs_added: number; paragraphs_removed: number; paragraphs_unchanged: number };

type ChapterCard =
  | { incoming_index: number; role: 'unchanged' | 'modified'; title: string; chapter_number: number | null; current_chapter_id: string; current_title: string | null; renamed: boolean; current_word_count: number; incoming_word_count: number; section_summary: { modified: number; added: number; missing: number; unchanged: number }; missing_sections: { section_id: string; title: string | null; word_count: number }[]; incoming_body: string }
  | { incoming_index: number; role: 'new'; title: string; chapter_number: number | null; incoming_word_count: number; incoming_section_count: number }
  | { incoming_index: number; role: 'needs_review'; title: string; chapter_number: number | null; incoming_word_count: number; suggested_chapter_id?: string; candidates: { chapter_id: string; title: string; score: number }[] }
  | { role: 'missing'; current_chapter_id: string; title: string | null; chapter_number: number | null; current_word_count: number; section_count: number };

type Preview = {
  status: string;
  book?: { id: string; title: string };
  manuscript_hash?: string;
  current?: { chapters: number; sections: number; words: number };
  incoming?: { chapters: number; sections: number; words: number };
  summary?: { unchanged: number; modified: number; new: number; needs_review: number; missing: number };
  reordered?: boolean;
  chapters?: ChapterCard[];
  needs_review_indexes?: number[];
};

type SectionEntry =
  | { role: 'unchanged'; section_id: string; title: string | null; current_word_count: number; incoming_word_count: number }
  | { role: 'modified'; section_id: string; title: string | null; current_word_count: number; incoming_word_count: number; diff: DiffLine[]; summary: Summary }
  | { role: 'added'; title: string; incoming_word_count: number; diff: DiffLine[]; summary: Summary }
  | { role: 'missing'; section_id: string; title: string | null; current_word_count: number };
type DiffEntry = Extract<SectionEntry, { role: 'modified' } | { role: 'added' }>;

const FRIENDLY: Record<string, string> = {
  NOT_FOUND: 'This book could not be found.',
  NO_CHAPTERS: 'No chapters were detected. Chapters should start with a line like "Chapter 1: Title".',
  TARGET_CHANGED: 'This manuscript changed after you opened the comparison. Refresh before applying.',
  NEEDS_RESOLUTION: 'Some chapters still need a mapping choice before you can apply.',
  BAD_REQUEST: 'The uploaded manuscript is empty.',
  APPLY_FAILED: 'Something went wrong applying the manuscript, so nothing was changed. Please try again.'
};

const CHIP: Record<string, string> = {
  unchanged: 'bg-paper-sunken text-ink-soft',
  modified: 'bg-gold-soft text-gold-strong',
  new: 'bg-accent-soft text-accent-strong',
  needs_review: 'border border-sunrise/50 bg-sunrise-soft text-gold-strong',
  missing: 'border border-coral/50 bg-coral-soft text-accent-strong'
};
const LABEL: Record<string, string> = { unchanged: 'Unchanged', modified: 'Modified', new: 'New chapter', needs_review: 'Needs review', missing: 'Not in upload' };

export function BookManuscriptUpload({ bookId, onApplied }: { bookId: string; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [incoming, setIncoming] = useState('');
  const [fileName, setFileName] = useState('');
  const [step, setStep] = useState<'input' | 'review' | 'done'>('input');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mappings, setMappings] = useState<Record<number, string>>({});
  const [removals, setRemovals] = useState<Set<string>>(new Set());
  const [chapterRemovals, setChapterRemovals] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [diffs, setDiffs] = useState<Record<number, SectionEntry[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetChanged, setTargetChanged] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setMode('paste'); setIncoming(''); setFileName(''); setStep('input'); setPreview(null);
    setMappings({}); setRemovals(new Set()); setExpanded(new Set()); setDiffs({});
    setBusy(false); setError(null); setTargetChanged(false);
  }
  function close() { setOpen(false); reset(); }
  function toggleRemoval(id: string) { setRemovals((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleChapterRemoval(id: string) { setChapterRemovals((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (!/\.(docx|txt|md)$/i.test(file.name)) { setError('Unsupported file type. Please upload a .docx, .txt, or .md file.'); return; }
    setBusy(true); setError(null);
    try {
      const form = new FormData(); form.append('file', file);
      const res = await fetch('/api/sections/extract', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) { setError(json.error || "We couldn't read that file."); return; }
      setIncoming(json.text); setFileName(file.name);
    } catch { setError('Something went wrong reading that file. Try pasting the text instead.'); }
    finally { setBusy(false); }
  }

  async function doReview() {
    if (!incoming.trim()) { setError('Paste or upload the manuscript first.'); return; }
    setBusy(true); setError(null); setTargetChanged(false);
    try {
      const res = await fetch('/api/books/preview-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, incoming_content: incoming })
      });
      const p = (await res.json()) as Preview;
      if (p.status === 'changed' || p.status === 'UNCHANGED') { setPreview(p); setMappings({}); setRemovals(new Set()); setChapterRemovals(new Set()); setExpanded(new Set()); setDiffs({}); setStep('review'); }
      else setError(FRIENDLY[p.status] ?? 'Something went wrong. Please try again.');
    } catch { setError('Could not compare the manuscript. Please try again.'); }
    finally { setBusy(false); }
  }

  async function toggleExpand(card: Extract<ChapterCard, { role: 'modified' | 'unchanged' }>) {
    const i = card.incoming_index;
    setExpanded((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
    if (!diffs[i]) {
      try {
        const res = await fetch('/api/chapters/preview-version', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: bookId, chapter_id: card.current_chapter_id, incoming_content: card.incoming_body })
        });
        const cp = await res.json();
        if (cp.sections) setDiffs((d) => ({ ...d, [i]: cp.sections as SectionEntry[] }));
      } catch { /* diff is best-effort */ }
    }
  }

  const unresolved = (preview?.needs_review_indexes ?? []).filter((i) => !mappings[i]);

  async function doApply() {
    if (!preview?.manuscript_hash) return;
    if (unresolved.length) { setError('Please choose a mapping for every chapter that needs review.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/books/apply-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId, incoming_content: incoming, expected_manuscript_hash: preview.manuscript_hash,
          mappings: Object.fromEntries(Object.entries(mappings).map(([k, v]) => [String(k), v])),
          section_removals: [...removals], chapter_deactivations: [...chapterRemovals],
          source: fileName ? 'file' : 'paste', source_filename: fileName || undefined
        })
      });
      const r = (await res.json()) as { status: string };
      if (r.status === 'applied' || r.status === 'UNCHANGED') { setStep('done'); onApplied(); }
      else if (r.status === 'TARGET_CHANGED') { setTargetChanged(true); setError('This manuscript changed after you opened the comparison. Refresh before applying.'); }
      else setError(FRIENDLY[r.status] ?? 'Something went wrong. Please try again.');
    } catch { setError('Could not apply the manuscript. Please try again.'); }
    finally { setBusy(false); }
  }

  const btn = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-sm font-semibold transition';
  const s = preview?.summary;
  const availableTargets = (card: Extract<ChapterCard, { role: 'needs_review' }>) => {
    const opts = new Map<string, string>();
    card.candidates.forEach((c) => opts.set(c.chapter_id, `${c.title} (${Math.round(c.score * 100)}% match)`));
    (preview?.chapters ?? []).forEach((c) => { if (c.role === 'missing') opts.set(c.current_chapter_id, c.title ?? 'Untitled'); });
    return [...opts.entries()];
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-soft transition hover:border-accent hover:text-accent-strong"
      >
        ⤒ Upload new manuscript version
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" onClick={close}>
          <div className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-[0_-8px_40px_rgba(27,23,23,0.2)] sm:max-w-4xl sm:rounded-2xl sm:shadow-[0_12px_48px_rgba(27,23,23,0.2)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="font-display text-xl text-ink">Upload New Manuscript Version</h2>
                <p className="mt-0.5 truncate text-xs text-ink-faint">A newer draft of this whole book — compared chapter by chapter</p>
              </div>
              <button onClick={close} aria-label="Close" className="-mr-1 rounded-lg p-2 text-ink-soft transition hover:bg-paper-sunken">✕</button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
              {error && <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}

              {step === 'input' && (
                <div>
                  <div className="mb-4 inline-flex rounded-lg border border-line bg-paper p-1 text-sm">
                    {(['paste', 'file'] as const).map((m) => (
                      <button key={m} onClick={() => setMode(m)} className={`min-h-[36px] rounded-md px-3 font-medium transition ${mode === m ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:text-ink'}`}>
                        {m === 'paste' ? 'Paste manuscript' : 'Upload file'}
                      </button>
                    ))}
                  </div>
                  {mode === 'paste' ? (
                    <textarea value={incoming} onChange={(e) => setIncoming(e.target.value)} placeholder="Paste the full manuscript. Each chapter starts with a line like “Chapter 1: Title”; use ~~~ between scenes for separate sections…" className="h-[46vh] w-full resize-none rounded-xl border border-line bg-white p-3 text-base leading-7 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent" />
                  ) : (
                    <div>
                      <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-paper px-4 py-10 text-center transition hover:border-accent">
                        <span className="font-display text-lg text-ink">{fileName || 'Choose a file'}</span>
                        <span className="mt-1 text-sm text-ink-soft">Word (.docx), text (.txt), or Markdown (.md)</span>
                      </button>
                      <input ref={fileRef} type="file" accept=".docx,.txt,.md" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
                      {incoming && fileName && <p className="mt-3 text-xs text-ink-faint">Loaded “{fileName}”. Continue to compare it with your current manuscript.</p>}
                    </div>
                  )}
                  <p className="mt-3 text-xs text-ink-faint">This updates the book already in Book Build. Chapters in the book but missing from your upload are kept — nothing is deleted without your say-so.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-8 text-center">
                  <p className="font-display text-lg text-ink">No changes to apply</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">This manuscript matches the current one, so there's nothing to replace.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'changed' && s && (
                <div>
                  {targetChanged && (
                    <div className="mb-3 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">
                      This manuscript changed after you opened the comparison. <button onClick={doReview} className="font-semibold underline">Refresh comparison</button> to review the latest before applying.
                    </div>
                  )}

                  <div className="mb-4 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl border border-line bg-paper px-4 py-3">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Current</p>
                      <p className="mt-1 text-sm text-ink">{preview.current?.chapters} chapters · {preview.current?.sections} sections · {preview.current?.words} words</p>
                    </div>
                    <div className="rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-accent-strong">Uploaded</p>
                      <p className="mt-1 text-sm text-ink">{preview.incoming?.chapters} chapters · {preview.incoming?.sections} sections · {preview.incoming?.words} words</p>
                    </div>
                  </div>

                  <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                    <span>✓ <b className="text-ink">{s.unchanged}</b> unchanged</span>
                    <span>~ <b className="text-ink">{s.modified}</b> modified</span>
                    <span>+ <b className="text-ink">{s.new}</b> new</span>
                    {s.needs_review > 0 && <span className="text-gold-strong">? {s.needs_review} need review</span>}
                    {s.missing > 0 && <span>− <b className="text-ink">{s.missing}</b> not in upload</span>}
                    {preview.reordered && <span className="text-gold-strong">order changed</span>}
                  </div>
                  {unresolved.length > 0 && <p className="mb-3 mt-1 text-xs text-gold-strong">{unresolved.length} chapter{unresolved.length > 1 ? 's' : ''} need a mapping choice before you can apply.</p>}

                  <ul className="mt-3 space-y-2">
                    {preview.chapters?.map((c, idx) => {
                      const key = 'incoming_index' in c ? `i${c.incoming_index}` : `m${idx}`;
                      const title = c.title || 'Untitled chapter';
                      if (c.role === 'unchanged' || c.role === 'modified') {
                        const isOpen = expanded.has(c.incoming_index);
                        return (
                          <li key={key} className="rounded-xl border border-line bg-paper">
                            <div className="flex items-start justify-between gap-3 px-4 py-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CHIP[c.role]}`}>{LABEL[c.role]}</span>
                                  <span className="min-w-0 truncate font-display text-base text-ink">{title}</span>
                                </div>
                                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-faint">
                                  <span>{c.current_word_count} → {c.incoming_word_count} words</span>
                                  {c.role === 'modified' && <span>{c.section_summary.modified} modified · {c.section_summary.added} new · {c.section_summary.missing} not in upload</span>}
                                  {c.renamed && <span className="text-gold-strong">Renamed from “{c.current_title}”</span>}
                                </div>
                              </div>
                              {c.role === 'modified' && <button onClick={() => toggleExpand(c)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition hover:border-accent">{isOpen ? 'Hide' : 'Compare'}</button>}
                            </div>
                            {c.role === 'modified' && isOpen && (
                              <div className="space-y-3 border-t border-line px-4 py-3">
                                {c.missing_sections.length > 0 && (
                                  <div className="rounded-lg border border-sunrise/40 bg-sunrise-soft/50 px-3 py-2">
                                    <p className="text-xs font-semibold text-gold-strong">Sections in this chapter but not in the upload — kept unless you remove them:</p>
                                    {c.missing_sections.map((ms) => (
                                      <label key={ms.section_id} className="mt-1 flex items-center gap-2 text-sm text-ink-soft">
                                        <input type="checkbox" checked={removals.has(ms.section_id)} onChange={() => toggleRemoval(ms.section_id)} className="h-4 w-4 rounded border-line-strong" />
                                        Remove “{ms.title || 'Untitled section'}” ({ms.word_count} words)
                                      </label>
                                    ))}
                                  </div>
                                )}
                                {(diffs[c.incoming_index] ?? []).filter((se): se is DiffEntry => se.role === 'modified' || se.role === 'added').map((se, k) => (
                                  <div key={k}>
                                    <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">{se.role === 'added' ? 'New section' : 'Modified section'}</p>
                                    <SectionVersionDiff diff={se.diff} wordBefore={se.role === 'modified' ? se.current_word_count : 0} wordAfter={se.incoming_word_count} summary={se.summary} beforeLabel="Current" afterLabel="Uploaded" />
                                  </div>
                                ))}
                                {!diffs[c.incoming_index] && <p className="text-xs text-ink-faint">Loading comparison…</p>}
                              </div>
                            )}
                          </li>
                        );
                      }
                      if (c.role === 'new') {
                        return (
                          <li key={key} className="rounded-xl border border-line bg-paper px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CHIP.new}`}>{LABEL.new}</span>
                              <span className="min-w-0 truncate font-display text-base text-ink">{title}</span>
                            </div>
                            <p className="mt-1 text-xs text-ink-faint">{c.incoming_section_count} sections · {c.incoming_word_count} words — will be added to the book.</p>
                          </li>
                        );
                      }
                      if (c.role === 'needs_review') {
                        return (
                          <li key={key} className="rounded-xl border border-sunrise/50 bg-sunrise-soft/40 px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CHIP.needs_review}`}>{LABEL.needs_review}</span>
                              <span className="min-w-0 truncate font-display text-base text-ink">{title}</span>
                            </div>
                            <p className="mt-1 text-xs text-ink-soft">Book Build isn't sure which existing chapter this replaces. Please choose:</p>
                            <select
                              value={mappings[c.incoming_index] ?? ''}
                              onChange={(e) => setMappings((m) => ({ ...m, [c.incoming_index]: e.target.value }))}
                              className="mt-2 min-h-[44px] w-full rounded-lg border border-line bg-white px-3 text-sm text-ink"
                            >
                              <option value="">— Choose —</option>
                              {availableTargets(c).map(([id, label]) => <option key={id} value={id}>Replaces: {label}</option>)}
                              <option value="new">This is a new chapter</option>
                            </select>
                          </li>
                        );
                      }
                      // missing chapter — KEEP by default, or explicitly remove (reversible)
                      if (c.role !== 'missing') return null;
                      const removing = chapterRemovals.has(c.current_chapter_id);
                      return (
                        <li key={key} className="rounded-xl border border-coral/40 bg-coral-soft/40 px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CHIP.missing}`}>{LABEL.missing}</span>
                            <span className="min-w-0 truncate font-display text-base text-ink">{title}</span>
                          </div>
                          <p className="mt-1 text-xs text-ink-soft">{c.section_count} sections · {c.current_word_count} words.</p>
                          <label className="mt-2 flex items-center gap-2 text-sm text-ink-soft">
                            <input type="checkbox" checked={removing} onChange={() => toggleChapterRemoval(c.current_chapter_id)} className="h-4 w-4 rounded border-line-strong" />
                            Remove from manuscript
                          </label>
                          <p className="mt-1 text-xs text-ink-faint">{removing ? 'Will be removed from the current manuscript — recoverable through Version History.' : 'Kept by default. It stays in your manuscript.'}</p>
                        </li>
                      );
                    })}
                  </ul>

                  {(removals.size > 0 || chapterRemovals.size > 0) && (
                    <div className="mt-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">
                      This will remove {chapterRemovals.size > 0 && <b>{chapterRemovals.size} chapter{chapterRemovals.size > 1 ? 's' : ''}</b>}{chapterRemovals.size > 0 && removals.size > 0 ? ' and ' : ''}{removals.size > 0 && <>{removals.size} section{removals.size > 1 ? 's' : ''}</>} from the active manuscript. Everything removed stays recoverable through Version History.
                    </div>
                  )}
                  <p className="mt-4 text-sm text-ink-soft">Your current manuscript will be saved to Version History before this version becomes active.</p>
                </div>
              )}

              {step === 'done' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                  <p className="font-display text-xl text-ink">New manuscript version saved</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">Your previous manuscript is in Version History.</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {step === 'input' && (
                <>
                  <button onClick={close} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Cancel</button>
                  <button onClick={doReview} disabled={busy || !incoming.trim()} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Working…' : 'Compare changes'}</button>
                </>
              )}
              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <>
                  <button onClick={() => { setStep('input'); setPreview(null); }} className={`${btn} border border-line text-ink hover:border-accent`}>Choose another</button>
                  <button onClick={close} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Cancel</button>
                </>
              )}
              {step === 'review' && preview?.status === 'changed' && (
                <>
                  <button onClick={() => setStep('input')} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Back</button>
                  <button onClick={doApply} disabled={busy || unresolved.length > 0} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Applying…' : 'Use This Manuscript Version'}</button>
                </>
              )}
              {step === 'done' && <button onClick={close} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong`}>Done</button>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
