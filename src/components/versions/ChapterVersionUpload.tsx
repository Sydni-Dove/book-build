'use client';

import { useRef, useState } from 'react';
import { SectionVersionDiff } from '@/components/versions/SectionVersionDiff';

type DiffLine = { kind: 'common' | 'removed' | 'added'; text: string };
type Summary = { paragraphs_added: number; paragraphs_removed: number; paragraphs_unchanged: number };
type PreviewSection =
  | { role: 'unchanged' | 'modified'; section_id: string; title: string | null; current_word_count: number; incoming_word_count: number; diff: DiffLine[]; summary: Summary }
  | { role: 'added'; title: string; incoming_word_count: number; diff: DiffLine[]; summary: Summary }
  | { role: 'missing'; section_id: string; title: string | null; current_word_count: number };

type ChapterPreview = {
  status: string;
  chapter?: { id: string; title: string; chapter_number: number | null };
  chapter_hash?: string;
  summary?: { modified: number; unchanged: number; added: number; missing: number };
  reordered?: boolean;
  sections?: PreviewSection[];
};

const FRIENDLY: Record<string, string> = {
  NOT_FOUND: 'This chapter could not be found. It may have been removed.',
  WRONG_RELATIONSHIP: "This chapter doesn't belong to the current book.",
  TARGET_CHANGED: 'This chapter changed after you opened the comparison. Refresh before applying.',
  BAD_REQUEST: 'The uploaded chapter is empty.',
  APPLY_FAILED: "Something went wrong applying the chapter, so nothing was changed. Please try again."
};

const ROLE_LABEL: Record<string, string> = { modified: 'Modified', unchanged: 'Unchanged', added: 'New section', missing: 'Not in upload' };
const ROLE_CHIP: Record<string, string> = {
  modified: 'bg-gold-soft text-gold-strong',
  unchanged: 'bg-paper-sunken text-ink-soft',
  added: 'bg-accent-soft text-accent-strong',
  missing: 'border border-sunrise/50 bg-sunrise-soft text-gold-strong'
};

export function ChapterVersionUpload({
  bookId,
  chapterId,
  chapterNumber,
  onApplied
}: {
  bookId: string;
  chapterId: string;
  chapterNumber?: number | null;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [incoming, setIncoming] = useState('');
  const [fileName, setFileName] = useState('');
  const [step, setStep] = useState<'input' | 'review' | 'done'>('input');
  const [preview, setPreview] = useState<ChapterPreview | null>(null);
  const [removals, setRemovals] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetChanged, setTargetChanged] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setMode('paste'); setIncoming(''); setFileName(''); setStep('input');
    setPreview(null); setRemovals(new Set()); setExpanded(new Set());
    setBusy(false); setError(null); setTargetChanged(false);
  }
  function close() { setOpen(false); reset(); }
  function toggleExpand(i: number) { setExpanded((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); }
  function toggleRemoval(id: string) { setRemovals((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

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
    if (!incoming.trim()) { setError('Paste or upload the new chapter first.'); return; }
    setBusy(true); setError(null); setTargetChanged(false);
    try {
      const res = await fetch('/api/chapters/preview-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, incoming_content: incoming })
      });
      const p = (await res.json()) as ChapterPreview;
      if (p.status === 'changed' || p.status === 'UNCHANGED') { setPreview(p); setRemovals(new Set()); setExpanded(new Set()); setStep('review'); }
      else setError(FRIENDLY[p.status] ?? 'Something went wrong. Please try again.');
    } catch { setError('Could not compare the chapter. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doApply() {
    if (!preview?.chapter_hash) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/chapters/apply-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, incoming_content: incoming, expected_chapter_hash: preview.chapter_hash, removals: [...removals] })
      });
      const r = (await res.json()) as { status: string };
      if (r.status === 'applied') { setStep('done'); onApplied(); }
      else if (r.status === 'TARGET_CHANGED') { setTargetChanged(true); setError('This chapter changed after you opened the comparison. Refresh the comparison before applying.'); }
      else setError(FRIENDLY[r.status] ?? 'Something went wrong. Please try again.');
    } catch { setError('Could not apply the chapter. Please try again.'); }
    finally { setBusy(false); }
  }

  const btn = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-sm font-semibold transition';
  const s = preview?.summary;
  const chLabel = chapterNumber ? `Chapter ${chapterNumber}` : 'Chapter';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-soft transition hover:border-accent hover:text-accent-strong"
      >
        ⤒ Upload chapter
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" onClick={close}>
          <div
            className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-[0_-8px_40px_rgba(27,23,23,0.2)] sm:max-w-4xl sm:rounded-2xl sm:shadow-[0_12px_48px_rgba(27,23,23,0.2)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* header */}
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="font-display text-xl text-ink">Upload New Chapter Version</h2>
                <p className="mt-0.5 truncate text-xs text-ink-faint">Replacing {chLabel} — section by section</p>
              </div>
              <button onClick={close} aria-label="Close" className="-mr-1 rounded-lg p-2 text-ink-soft transition hover:bg-paper-sunken">✕</button>
            </div>

            {/* body — vertical scroll only */}
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
              {error && <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}

              {step === 'input' && (
                <div>
                  <div className="mb-4 inline-flex rounded-lg border border-line bg-paper p-1 text-sm">
                    {(['paste', 'file'] as const).map((m) => (
                      <button key={m} onClick={() => setMode(m)} className={`min-h-[36px] rounded-md px-3 font-medium transition ${mode === m ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:text-ink'}`}>
                        {m === 'paste' ? 'Paste chapter' : 'Upload file'}
                      </button>
                    ))}
                  </div>
                  {mode === 'paste' ? (
                    <textarea
                      value={incoming}
                      onChange={(e) => setIncoming(e.target.value)}
                      placeholder="Paste the entire chapter. Use a line of ~~~ between scenes to keep separate sections…"
                      className="h-[46vh] w-full resize-none rounded-xl border border-line bg-white p-3 text-base leading-7 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                    />
                  ) : (
                    <div>
                      <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-paper px-4 py-10 text-center transition hover:border-accent">
                        <span className="font-display text-lg text-ink">{fileName || 'Choose a file'}</span>
                        <span className="mt-1 text-sm text-ink-soft">Word (.docx), text (.txt), or Markdown (.md)</span>
                      </button>
                      <input ref={fileRef} type="file" accept=".docx,.txt,.md" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
                      {incoming && fileName && <p className="mt-3 text-xs text-ink-faint">Loaded “{fileName}”. Continue to review the proposed changes.</p>}
                    </div>
                  )}
                  <p className="mt-3 text-xs text-ink-faint">Sections are split on lines of <code className="font-mono">~~~</code>. Sections already in the chapter but missing from your upload are preserved unless you choose to remove them.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-8 text-center">
                  <p className="font-display text-lg text-ink">No changes to apply</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">This upload matches the current chapter, so there's nothing to replace.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'changed' && s && (
                <div>
                  {targetChanged && (
                    <div className="mb-3 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">
                      This chapter changed after you opened the comparison. <button onClick={doReview} className="font-semibold underline">Refresh comparison</button> to review the latest before applying.
                    </div>
                  )}

                  {/* Chapter-level summary */}
                  <div className="mb-4 rounded-xl border border-line bg-paper px-4 py-3">
                    <p className="font-display text-lg text-ink">{chLabel} — Proposed Changes</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                      <span><b className="text-ink">{s.modified}</b> changed</span>
                      <span><b className="text-ink">{s.unchanged}</b> unchanged</span>
                      <span><b className="text-ink">{s.added}</b> new</span>
                      <span><b className="text-ink">{s.missing}</b> not in upload</span>
                      {preview.reordered && <span className="text-gold-strong">order changed</span>}
                    </div>
                  </div>

                  {preview.reordered && (
                    <div className="mb-3 rounded-lg border border-line bg-paper-sunken px-3 py-2 text-xs text-ink-soft">The uploaded chapter changes the section order. The new order is shown below, top to bottom.</div>
                  )}

                  {/* Per-section cards */}
                  <ul className="space-y-2">
                    {preview.sections?.map((sec, i) => {
                      const title = sec.title || (sec.role === 'added' ? 'New section' : 'Untitled section');
                      const canExpand = sec.role === 'modified' || sec.role === 'added';
                      return (
                        <li key={i} className="rounded-xl border border-line bg-paper">
                          <div className="flex items-start justify-between gap-3 px-4 py-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${ROLE_CHIP[sec.role]}`}>{ROLE_LABEL[sec.role]}</span>
                                <span className="min-w-0 truncate font-display text-base text-ink">{title}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-faint">
                                {'current_word_count' in sec && <span>Current {sec.current_word_count} words</span>}
                                {'incoming_word_count' in sec && <span>Uploaded {sec.incoming_word_count} words</span>}
                                {sec.role === 'missing' && <span className="text-gold-strong">Currently in chapter but not found in the uploaded version</span>}
                              </div>
                            </div>
                            {canExpand && (
                              <button onClick={() => toggleExpand(i)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition hover:border-accent">
                                {expanded.has(i) ? 'Hide' : sec.role === 'added' ? 'View' : 'Compare'}
                              </button>
                            )}
                          </div>

                          {sec.role === 'missing' && (
                            <div className="border-t border-line px-4 py-2">
                              <label className="flex items-center gap-2 text-sm text-ink-soft">
                                <input type="checkbox" checked={removals.has(sec.section_id)} onChange={() => toggleRemoval(sec.section_id)} className="h-4 w-4 rounded border-line-strong text-accent focus:ring-accent" />
                                Remove this section (it will be deleted from the chapter)
                              </label>
                              {!removals.has(sec.section_id) && <p className="mt-1 text-xs text-ink-faint">Preserved by default — it stays in the chapter.</p>}
                            </div>
                          )}

                          {canExpand && expanded.has(i) && 'diff' in sec && (
                            <div className="border-t border-line px-4 py-3">
                              <SectionVersionDiff
                                diff={sec.diff}
                                wordBefore={'current_word_count' in sec ? sec.current_word_count : 0}
                                wordAfter={sec.incoming_word_count}
                                summary={sec.summary}
                                beforeLabel="Current"
                                afterLabel="Uploaded"
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  <p className="mt-4 text-sm text-ink-soft">Your current chapter will be saved to Version History before these changes are applied, so this can be undone.</p>
                </div>
              )}

              {step === 'done' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                  <p className="font-display text-xl text-ink">Chapter version saved</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">Your previous chapter is available in Version History.</p>
                </div>
              )}
            </div>

            {/* footer */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {step === 'input' && (
                <>
                  <button onClick={close} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Cancel</button>
                  <button onClick={doReview} disabled={busy || !incoming.trim()} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Working…' : 'Review changes'}</button>
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
                  <button onClick={doApply} disabled={busy} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Applying…' : 'Apply chapter changes'}</button>
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
