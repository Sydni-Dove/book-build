'use client';

import { useState } from 'react';
import { SectionVersionDiff } from '@/components/versions/SectionVersionDiff';

type DiffLine = { kind: 'common' | 'removed' | 'added'; text: string };
type Summary = { paragraphs_added: number; paragraphs_removed: number; paragraphs_unchanged: number };

type VersionRow = { version_id: string; created_at: string; version_reason: string; source: string | null; source_filename: string | null; chapter_count: number; section_count: number; word_count: number };
type ListResult = { status: string; book?: { id: string; title: string }; current?: { chapters: number; sections: number; words: number }; count?: number; versions?: VersionRow[] };

type SectionEntry =
  | { role: 'unchanged'; section_id: string; title: string | null }
  | { role: 'modified'; section_id: string; title: string | null; renamed?: boolean; current_word_count: number; selected_word_count: number; diff: DiffLine[]; summary: Summary }
  | { role: 'only_in_current'; section_id: string; title: string | null; current_word_count: number }
  | { role: 'only_in_selected'; section_id: string; title: string | null; selected_word_count: number; diff: DiffLine[]; summary: Summary };
type ChapterCard =
  | { role: 'unchanged' | 'modified'; chapter_id: string; title: string; current_title: string | null; renamed: boolean; current_word_count: number; selected_word_count: number; section_summary: { modified: number; unchanged: number; only_in_current: number; only_in_selected: number; renamed: number }; section_reordered: boolean; sections: SectionEntry[] }
  | { role: 'will_remove'; chapter_id: string; title: string | null; chapter_number: number | null; current_word_count: number; section_count: number }
  | { role: 'will_reactivate'; chapter_id: string; title: string | null; section_count: number; selected_word_count: number }
  | { role: 'only_in_selected'; chapter_id: string; title: string | null; section_count: number; needs_reactivation: boolean };
type RestorePreview = {
  status: string;
  manuscript_hash?: string;
  can_restore?: boolean;
  blocking_issues?: string[];
  will_remove_chapters?: number;
  will_reactivate_chapters?: number;
  selected?: { snapshot_id: string; created_at: string; version_reason: string; source: string | null; chapters: number; sections: number; words: number };
  current?: { chapters: number; sections: number; words: number };
  summary?: { chapters_modified: number; chapters_unchanged: number; chapters_renamed: number; will_reactivate: number; will_remove: number; only_in_selected: number };
  reordered?: boolean;
  chapters?: ChapterCard[];
  removed_chapters?: { chapter_id: string; title: string | null }[];
};

const REASON_LABELS: Record<string, string> = { before_manuscript_upload: 'Before an uploaded version', before_manuscript_restore: 'Before a restore', manual_snapshot: 'Manual snapshot' };
const reasonLabel = (r: string) => REASON_LABELS[r] ?? 'Saved manuscript version';
const FRIENDLY: Record<string, string> = {
  NOT_FOUND: 'This book could not be found.', VERSION_NOT_FOUND: 'That manuscript version could not be found for this book.',
  TARGET_CHANGED: 'This manuscript changed after you opened this comparison. Refresh before restoring.',
  CHAPTER_REACTIVATION_REQUIRED: 'This version includes a chapter that no longer exists and cannot be safely recreated yet, so it cannot be restored.',
  MALFORMED_SNAPSHOT: 'This saved version could not be read. Nothing was changed.', RESTORE_FAILED: 'Something went wrong restoring, so nothing was changed. Please try again.',
  LIST_FAILED: 'Could not load manuscript history. Please try again.'
};
const CH_CHIP: Record<string, string> = { unchanged: 'bg-paper-sunken text-ink-soft', modified: 'bg-gold-soft text-gold-strong', will_reactivate: 'bg-accent-soft text-accent-strong', will_remove: 'border border-coral/50 bg-coral-soft text-accent-strong', only_in_selected: 'border border-coral/50 bg-coral-soft text-accent-strong' };
const CH_LABEL: Record<string, string> = { unchanged: 'Unchanged', modified: 'Modified', will_reactivate: 'Returns to manuscript', will_remove: 'Will be removed', only_in_selected: 'Only in this version' };

function formatWhen(iso: string) { const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso; return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`; }

export function BookManuscriptHistory({ bookId, onRestored }: { bookId: string; onRestored?: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'list' | 'review' | 'done'>('list');
  const [list, setList] = useState<ListResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetChanged, setTargetChanged] = useState(false);

  function reset() { setStep('list'); setList(null); setSelectedId(null); setPreview(null); setExpanded(new Set()); setBusy(false); setError(null); setTargetChanged(false); }
  function close() { setOpen(false); reset(); }
  function toggle(i: number) { setExpanded((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); }

  async function openHistory() {
    setOpen(true); reset(); setBusy(true);
    try {
      const res = await fetch('/api/books/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bookId }) });
      const j = (await res.json()) as ListResult;
      if (j.status === 'ok') setList(j); else setError(FRIENDLY[j.status] ?? 'Could not load manuscript history.');
    } catch { setError('Could not load manuscript history. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doPreview(snapshotId: string) {
    setSelectedId(snapshotId); setBusy(true); setError(null); setTargetChanged(false); setExpanded(new Set());
    try {
      const res = await fetch('/api/books/preview-restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bookId, snapshot_id: snapshotId }) });
      const p = (await res.json()) as RestorePreview;
      if (p.status === 'changed' || p.status === 'UNCHANGED') { setPreview(p); setStep('review'); }
      else setError(FRIENDLY[p.status] ?? 'Could not compare versions. Please try again.');
    } catch { setError('Could not compare versions. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doRestore() {
    if (!selectedId || !preview?.manuscript_hash) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/books/apply-restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: bookId, snapshot_id: selectedId, expected_manuscript_hash: preview.manuscript_hash }) });
      const r = (await res.json()) as { status: string };
      if (r.status === 'applied') { setStep('done'); onRestored?.(); }
      else if (r.status === 'TARGET_CHANGED') { setTargetChanged(true); setError('This manuscript changed after you opened this comparison. Refresh before restoring.'); }
      else setError(FRIENDLY[r.status] ?? 'Could not restore this version. Please try again.');
    } catch { setError('Could not restore this version. Please try again.'); }
    finally { setBusy(false); }
  }

  const versions = list?.versions ?? [];
  const s = preview?.summary;
  const btn = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-sm font-semibold transition';

  return (
    <>
      <button onClick={openHistory} className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-ink-soft transition hover:text-accent-strong">↻ Manuscript history</button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" onClick={close}>
          <div className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-[0_-8px_40px_rgba(27,23,23,0.2)] sm:max-w-4xl sm:rounded-2xl sm:shadow-[0_12px_48px_rgba(27,23,23,0.2)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="font-display text-xl text-ink">Manuscript Version History</h2>
                <p className="mt-0.5 truncate text-xs text-ink-faint">{step === 'review' ? 'Compare, then restore if you choose' : 'Whole-book checkpoints of this manuscript'}</p>
              </div>
              <button onClick={close} aria-label="Close" className="-mr-1 rounded-lg p-2 text-ink-soft transition hover:bg-paper-sunken">✕</button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
              {error && <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}

              {step === 'list' && (
                <div>
                  {list?.current && (
                    <div className="mb-4 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-accent-strong">Current manuscript</p>
                        <span className="text-xs text-ink-soft">{list.current.chapters} chapters · {list.current.sections} sections · {list.current.words} words · live</span>
                      </div>
                    </div>
                  )}
                  {busy && !list && <p className="py-8 text-center text-sm text-ink-faint">Loading manuscript history…</p>}
                  {list && versions.length === 0 && (
                    <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                      <p className="font-display text-lg text-ink">No previous manuscript versions yet</p>
                      <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">Previous versions appear here after you upload a new manuscript version or restore an earlier one.</p>
                    </div>
                  )}
                  {versions.length > 0 && (
                    <ul className="space-y-2">
                      {versions.map((v) => (
                        <li key={v.version_id}>
                          <button onClick={() => doPreview(v.version_id)} disabled={busy} className="flex w-full flex-col gap-1 rounded-xl border border-line bg-paper px-4 py-3 text-left transition hover:border-accent disabled:opacity-50">
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                              <span className="font-display text-base text-ink">{reasonLabel(v.version_reason)}</span>
                              <span className="text-xs text-ink-faint">{formatWhen(v.created_at)}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                              <span>{v.chapter_count} chapters</span><span className="text-ink-faint">·</span><span>{v.section_count} sections</span><span className="text-ink-faint">·</span><span>{v.word_count} words</span>
                              {v.source && <><span className="text-ink-faint">·</span><span>{v.source === 'file' ? (v.source_filename || 'file') : v.source === 'restore' ? 'restore point' : 'pasted'}</span></>}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-8 text-center">
                  <p className="font-display text-lg text-ink">This version matches the current manuscript</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">There's nothing to restore — it's identical to what's live now.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'changed' && s && (
                <div>
                  {targetChanged && (
                    <div className="mb-3 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">This manuscript changed after you opened this comparison. <button onClick={() => selectedId && doPreview(selectedId)} className="font-semibold underline">Refresh comparison</button> to review the latest before restoring.</div>
                  )}
                  <div className="mb-4 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl border border-line bg-paper px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Current</p><p className="mt-1 text-sm text-ink">{preview.current?.chapters} chapters · {preview.current?.sections} sections · {preview.current?.words} words</p></div>
                    <div className="rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-wide text-accent-strong">Selected version</p><p className="mt-1 text-sm text-ink">{preview.selected?.chapters} chapters · {preview.selected?.sections} sections · {preview.selected?.words} words · {preview.selected && formatWhen(preview.selected.created_at).split(' · ')[0]}</p></div>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                    <span><b className="text-ink">{s.chapters_modified}</b> chapters change</span>
                    <span><b className="text-ink">{s.chapters_unchanged}</b> unchanged</span>
                    {s.will_reactivate > 0 && <span className="text-accent-strong">{s.will_reactivate} return</span>}
                    {s.will_remove > 0 && <span className="text-accent-strong">{s.will_remove} removed</span>}
                    {s.only_in_selected > 0 && <span className="text-accent-strong">{s.only_in_selected} can't be restored</span>}
                    {preview.reordered && <span className="text-gold-strong">order changed</span>}
                  </div>

                  {!preview.can_restore && (
                    <div className="mb-3 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">This version includes a chapter that no longer exists and can't be safely recreated, so it can't be restored.</div>
                  )}
                  {preview.can_restore && (preview.will_remove_chapters ?? 0) > 0 && (
                    <div className="mb-3 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">
                      Chapters added after this version will be removed from the current manuscript (reversible — kept in Version History): {preview.removed_chapters?.map((k) => k.title || 'Untitled').join(', ')}.
                    </div>
                  )}

                  <ul className="space-y-2">
                    {preview.chapters?.map((c, i) => {
                      const title = c.title || 'Untitled chapter';
                      if (c.role === 'unchanged' || c.role === 'modified') {
                        const isOpen = expanded.has(i);
                        return (
                          <li key={i} className="rounded-xl border border-line bg-paper">
                            <div className="flex items-start justify-between gap-3 px-4 py-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CH_CHIP[c.role]}`}>{CH_LABEL[c.role]}</span>
                                  <span className="min-w-0 truncate font-display text-base text-ink">{title}</span>
                                </div>
                                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-faint">
                                  <span>{c.current_word_count} → {c.selected_word_count} words</span>
                                  {c.role === 'modified' && <span>{c.section_summary.modified} modified · {c.section_summary.only_in_selected} returning · {c.section_summary.only_in_current} added later</span>}
                                  {c.renamed && <span className="text-gold-strong">Renamed from “{c.current_title}”</span>}
                                </div>
                              </div>
                              {c.role === 'modified' && <button onClick={() => toggle(i)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition hover:border-accent">{isOpen ? 'Hide' : 'Compare'}</button>}
                            </div>
                            {c.role === 'modified' && isOpen && (
                              <div className="space-y-3 border-t border-line px-4 py-3">
                                {c.sections.filter((se): se is Extract<SectionEntry, { role: 'modified' } | { role: 'only_in_selected' }> => se.role === 'modified' || se.role === 'only_in_selected').map((se, k) => (
                                  <div key={k}>
                                    <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">{se.role === 'only_in_selected' ? 'Returns on restore' : 'Modified section'}</p>
                                    <SectionVersionDiff diff={se.diff} wordBefore={se.role === 'modified' ? se.current_word_count : 0} wordAfter={se.selected_word_count} summary={se.summary} beforeLabel="Current" afterLabel="Selected version" />
                                  </div>
                                ))}
                                {c.sections.some((se) => se.role === 'only_in_current') && <p className="text-xs text-ink-faint">Sections added after this version are kept: {c.sections.filter((se) => se.role === 'only_in_current').map((se) => (se.title || 'Untitled')).join(', ')}.</p>}
                              </div>
                            )}
                          </li>
                        );
                      }
                      if (c.role === 'will_reactivate') {
                        return (
                          <li key={i} className="rounded-xl border border-accent/30 bg-accent-soft/30 px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CH_CHIP.will_reactivate}`}>{CH_LABEL.will_reactivate}</span><span className="min-w-0 truncate font-display text-base text-ink">{title}</span></div>
                            <p className="mt-1 text-xs text-ink-soft">{c.section_count} sections · {c.selected_word_count} words — was removed earlier; restoring brings it back with its original content and history.</p>
                          </li>
                        );
                      }
                      if (c.role === 'will_remove') {
                        return (
                          <li key={i} className="rounded-xl border border-coral/30 bg-coral-soft/30 px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CH_CHIP.will_remove}`}>{CH_LABEL.will_remove}</span><span className="min-w-0 truncate font-display text-base text-ink">{title}</span></div>
                            <p className="mt-1 text-xs text-ink-soft">Added after the selected version — will be removed from the current manuscript (recoverable through Version History).</p>
                          </li>
                        );
                      }
                      // only_in_selected — a chapter row that no longer exists (blocks restore)
                      return (
                        <li key={i} className="rounded-xl border border-coral/40 bg-coral-soft/40 px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CH_CHIP.only_in_selected}`}>{CH_LABEL.only_in_selected}</span><span className="min-w-0 truncate font-display text-base text-ink">{title}</span></div>
                          <p className="mt-1 text-xs text-accent-strong">This chapter no longer exists and can't be safely recreated yet.</p>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-4 text-sm text-ink-soft">Your current manuscript will be saved to Version History before this version is restored, so you can undo it.</p>
                </div>
              )}

              {step === 'done' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                  <p className="font-display text-xl text-ink">Manuscript restored</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">The manuscript now shows the restored version. The one you had before is saved in Version History.</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {step === 'list' && <button onClick={close} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Close</button>}
              {step === 'review' && preview?.status === 'UNCHANGED' && <button onClick={() => { setStep('list'); setPreview(null); setSelectedId(null); }} className={`${btn} border border-line text-ink hover:border-accent`}>Back to versions</button>}
              {step === 'review' && preview?.status === 'changed' && (
                <>
                  <button onClick={() => { setStep('list'); setPreview(null); setSelectedId(null); setTargetChanged(false); setError(null); }} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Back</button>
                  <button onClick={doRestore} disabled={busy || !preview.can_restore} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Restoring…' : 'Restore This Manuscript Version'}</button>
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
