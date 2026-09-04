'use client';

import { useState } from 'react';
import { SectionVersionDiff } from '@/components/versions/SectionVersionDiff';

type DiffLine = { kind: 'common' | 'removed' | 'added'; text: string };
type Summary = { paragraphs_added: number; paragraphs_removed: number; paragraphs_unchanged: number };

type VersionRow = { version_id: string; created_at: string; version_reason: string; chapter_title: string | null; section_count: number; word_count: number };
type ListResult = {
  status: string;
  chapter?: { id: string; title: string; chapter_number: number | null };
  current?: { word_count: number; section_count: number; content_hash: string };
  count?: number;
  versions?: VersionRow[];
};

type PreviewSection =
  | { role: 'unchanged'; section_id: string; title: string | null; current_word_count: number; selected_word_count: number }
  | { role: 'modified'; section_id: string; title: string | null; current_title: string | null; selected_title: string | null; renamed: boolean; current_word_count: number; selected_word_count: number; diff: DiffLine[]; summary: Summary }
  | { role: 'only_in_current'; section_id: string; title: string | null; current_word_count: number }
  | { role: 'only_in_selected'; section_id: string; title: string | null; selected_word_count: number; diff: DiffLine[]; summary: Summary };

type RestorePreview = {
  status: string;
  chapter?: { id: string; title: string; chapter_number: number | null };
  chapter_hash?: string;
  selected?: { version_id: string; created_at: string; version_reason: string; chapter_title: string | null; word_count: number; section_count: number };
  current?: { word_count: number; section_count: number };
  summary?: { unchanged: number; modified: number; only_in_current: number; only_in_selected: number; renamed: number };
  reordered?: boolean;
  sections?: PreviewSection[];
};

// Internal chapter version_reason → human label. Never expose raw db terms.
const REASON_LABELS: Record<string, string> = {
  before_chapter_upload: 'Before an uploaded version',
  before_chapter_restore: 'Before a restore',
  manual_snapshot: 'Manual snapshot'
};
const reasonLabel = (r: string) => REASON_LABELS[r] ?? 'Saved chapter version';

const FRIENDLY: Record<string, string> = {
  NOT_FOUND: 'This chapter could not be found. It may have been removed.',
  WRONG_RELATIONSHIP: "This chapter doesn't belong to the current book.",
  VERSION_NOT_FOUND: 'That chapter version could not be found for this chapter.',
  LIST_FAILED: "We couldn't load the chapter history. Please try again.",
  TARGET_CHANGED: 'This chapter changed after you opened this version. Refresh the comparison before restoring.',
  SNAPSHOT_FAILED: "We couldn't safely save your current chapter first, so nothing was changed. Please try again.",
  RESTORE_FAILED: "Something went wrong restoring the chapter, so nothing was changed. Please try again."
};

const ROLE_LABEL: Record<string, string> = { unchanged: 'Unchanged', modified: 'Modified', only_in_current: 'Only in current', only_in_selected: 'Only in this version' };
const ROLE_CHIP: Record<string, string> = {
  unchanged: 'bg-paper-sunken text-ink-soft',
  modified: 'bg-gold-soft text-gold-strong',
  only_in_current: 'border border-coral/50 bg-coral-soft text-accent-strong',
  only_in_selected: 'bg-accent-soft text-accent-strong'
};

function formatWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: iso, time: '' };
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  };
}

export function ChapterVersionHistory({
  bookId,
  chapterId,
  chapterNumber,
  onRestored
}: {
  bookId: string;
  chapterId: string;
  chapterNumber?: number | null;
  onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'list' | 'review' | 'done'>('list');
  const [list, setList] = useState<ListResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetChanged, setTargetChanged] = useState(false);

  function reset() {
    setStep('list'); setList(null); setSelectedId(null); setPreview(null);
    setExpanded(new Set()); setBusy(false); setError(null); setTargetChanged(false);
  }
  function close() { setOpen(false); reset(); }
  function toggleExpand(i: number) { setExpanded((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); }

  async function openHistory() {
    setOpen(true); reset(); setBusy(true);
    try {
      const res = await fetch('/api/chapters/versions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId })
      });
      const j = (await res.json()) as ListResult;
      if (j.status === 'ok') setList(j);
      else setError(FRIENDLY[j.status] ?? 'Could not load chapter history. Please try again.');
    } catch { setError('Could not load chapter history. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doPreview(versionId: string) {
    setSelectedId(versionId); setBusy(true); setError(null); setTargetChanged(false); setExpanded(new Set());
    try {
      const res = await fetch('/api/chapters/preview-restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, version_id: versionId })
      });
      const p = (await res.json()) as RestorePreview;
      if (p.status === 'changed' || p.status === 'UNCHANGED') { setPreview(p); setStep('review'); }
      else setError(FRIENDLY[p.status] ?? 'Could not compare versions. Please try again.');
    } catch { setError('Could not compare versions. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doRestore() {
    if (!selectedId || !preview?.chapter_hash) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/chapters/apply-restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, version_id: selectedId, expected_chapter_hash: preview.chapter_hash })
      });
      const r = (await res.json()) as { status: string };
      if (r.status === 'applied') { setStep('done'); onRestored(); }
      else if (r.status === 'TARGET_CHANGED') { setTargetChanged(true); setError('This chapter changed after you opened this version. Refresh the comparison before restoring.'); }
      else setError(FRIENDLY[r.status] ?? 'Could not restore this version. Please try again.');
    } catch { setError('Could not restore this version. Please try again.'); }
    finally { setBusy(false); }
  }

  const btn = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-sm font-semibold transition';
  const versions = list?.versions ?? [];
  const chLabel = chapterNumber ? `Chapter ${chapterNumber}` : 'Chapter';
  const s = preview?.summary;

  return (
    <>
      <button
        onClick={openHistory}
        className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-ink-soft transition hover:text-accent-strong"
      >
        ↻ Chapter history
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" onClick={close}>
          <div
            className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-[0_-8px_40px_rgba(27,23,23,0.2)] sm:max-w-4xl sm:rounded-2xl sm:shadow-[0_12px_48px_rgba(27,23,23,0.2)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="font-display text-xl text-ink">Chapter Version History</h2>
                <p className="mt-0.5 truncate text-xs text-ink-faint">
                  {step === 'review' ? `Compare ${chLabel}, then restore if you choose` : `Saved versions of ${chLabel}`}
                </p>
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
                        <p className="text-[11px] font-bold uppercase tracking-wide text-accent-strong">Current chapter</p>
                        <span className="text-xs text-ink-soft">{list.current.section_count} sections · {list.current.word_count} words · in the editor now</span>
                      </div>
                    </div>
                  )}
                  {busy && !list && <p className="py-8 text-center text-sm text-ink-faint">Loading chapter history…</p>}
                  {list && versions.length === 0 && (
                    <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                      <p className="font-display text-lg text-ink">No previous chapter versions yet</p>
                      <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">Chapter versions are created when a new chapter version is applied, or just before a chapter restore. Once that happens, earlier versions of this chapter will appear here.</p>
                    </div>
                  )}
                  {versions.length > 0 && (
                    <ul className="space-y-2">
                      {versions.map((v) => {
                        const when = formatWhen(v.created_at);
                        return (
                          <li key={v.version_id}>
                            <button onClick={() => doPreview(v.version_id)} disabled={busy} className="flex w-full flex-col gap-1 rounded-xl border border-line bg-paper px-4 py-3 text-left transition hover:border-accent disabled:opacity-50">
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                                <span className="font-display text-base text-ink">{reasonLabel(v.version_reason)}</span>
                                <span className="text-xs text-ink-faint">{when.date}{when.time ? ` · ${when.time}` : ''}</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                                {v.chapter_title && <span className="min-w-0 truncate">{v.chapter_title}</span>}
                                <span className="text-ink-faint">·</span>
                                <span>{v.section_count} sections</span>
                                <span className="text-ink-faint">·</span>
                                <span>{v.word_count} words</span>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-8 text-center">
                  <p className="font-display text-lg text-ink">This version matches the current chapter</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">There's nothing to restore — it's identical to what's in the editor now.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'changed' && s && (
                <div>
                  {targetChanged && (
                    <div className="mb-3 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">
                      This chapter changed after you opened this version. <button onClick={() => selectedId && doPreview(selectedId)} className="font-semibold underline">Refresh comparison</button> to review the latest before restoring.
                    </div>
                  )}

                  {/* chapter-level current vs selected */}
                  <div className="mb-4 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl border border-line bg-paper px-4 py-3">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Current chapter</p>
                      <p className="mt-1 font-display text-base text-ink">{preview.chapter?.title}</p>
                      <p className="mt-0.5 text-xs text-ink-soft">{preview.current?.section_count} sections · {preview.current?.word_count} words</p>
                    </div>
                    <div className="rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-accent-strong">Selected version</p>
                      <p className="mt-1 font-display text-base text-ink">{preview.selected?.chapter_title}</p>
                      <p className="mt-0.5 text-xs text-ink-soft">{preview.selected?.section_count} sections · {preview.selected?.word_count} words · {preview.selected && formatWhen(preview.selected.created_at).date}</p>
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                    <span><b className="text-ink">{s.modified}</b> modified</span>
                    <span><b className="text-ink">{s.unchanged}</b> unchanged</span>
                    <span><b className="text-ink">{s.only_in_selected}</b> only in this version</span>
                    <span><b className="text-ink">{s.only_in_current}</b> only in current</span>
                    {s.renamed > 0 && <span className="text-gold-strong">{s.renamed} renamed</span>}
                    {preview.reordered && <span className="text-gold-strong">order changed</span>}
                  </div>

                  <ul className="space-y-2">
                    {preview.sections?.map((sec, i) => {
                      const title = sec.title || 'Untitled section';
                      const canExpand = sec.role === 'modified' || sec.role === 'only_in_selected';
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
                                {'selected_word_count' in sec && <span>Version {sec.selected_word_count} words</span>}
                                {sec.role === 'modified' && sec.renamed && <span className="text-gold-strong">Renamed: “{sec.current_title || 'Untitled'}” → “{sec.selected_title || 'Untitled'}”</span>}
                                {sec.role === 'only_in_current' && <span className="text-accent-strong">Added after this version — restoring removes it</span>}
                                {sec.role === 'only_in_selected' && <span className="text-accent-strong">Restoring brings this section back</span>}
                              </div>
                            </div>
                            {canExpand && (
                              <button onClick={() => toggleExpand(i)} className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition hover:border-accent">
                                {expanded.has(i) ? 'Hide' : sec.role === 'only_in_selected' ? 'View' : 'Compare'}
                              </button>
                            )}
                          </div>
                          {canExpand && expanded.has(i) && 'diff' in sec && (
                            <div className="border-t border-line px-4 py-3">
                              <SectionVersionDiff
                                diff={sec.diff}
                                wordBefore={'current_word_count' in sec ? sec.current_word_count : 0}
                                wordAfter={sec.selected_word_count}
                                summary={sec.summary}
                                beforeLabel="Current"
                                afterLabel="Selected version"
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  <p className="mt-4 text-sm text-ink-soft">This is a whole-chapter restore. Your current chapter will first be saved to Version History, so you can undo this.</p>
                </div>
              )}

              {step === 'done' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                  <p className="font-display text-xl text-ink">Chapter restored</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">The chapter now shows the restored version. The chapter you had before is saved in Version History.</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {step === 'list' && <button onClick={close} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Close</button>}
              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <button onClick={() => { setStep('list'); setPreview(null); setSelectedId(null); }} className={`${btn} border border-line text-ink hover:border-accent`}>Back to versions</button>
              )}
              {step === 'review' && preview?.status === 'changed' && (
                <>
                  <button onClick={() => { setStep('list'); setPreview(null); setSelectedId(null); setTargetChanged(false); setError(null); }} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Back</button>
                  <button onClick={doRestore} disabled={busy} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Restoring…' : 'Restore This Chapter Version'}</button>
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
