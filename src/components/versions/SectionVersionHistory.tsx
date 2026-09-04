'use client';

import { useState } from 'react';
import { SectionVersionDiff } from '@/components/versions/SectionVersionDiff';

type VersionRow = {
  id: string;
  version_reason: string;
  created_at: string;
  word_count: number;
  excerpt: string;
};

type ListResult = {
  status: string;
  current?: { word_count: number; content_hash: string; updated_at?: string; excerpt?: string };
  count?: number;
  versions?: VersionRow[];
};

type RestorePreview = {
  status: string;
  version_id?: string;
  selected?: { version_reason: string; created_at: string; word_count: number };
  current?: { word_count: number; content_hash: string; updated_at?: string };
  word_count_before?: number;
  word_count_after?: number;
  summary?: { paragraphs_added: number; paragraphs_removed: number; paragraphs_unchanged: number };
  diff?: { kind: 'common' | 'removed' | 'added'; text: string }[];
};

// Internal version_reason → human label. Never expose raw DB terms. Both Upload
// and Restore snapshot the current content as `manual_snapshot` right before
// replacing it, so its label reads truthfully for either path.
const REASON_LABELS: Record<string, string> = {
  manual_snapshot: 'Saved before an update',
  before_fix_with_me: 'Before Fix With Me',
  before_ai_edit: 'Before an AI edit',
  before_continuity_correction: 'Before a continuity fix',
  before_chapter_revision: 'Before a chapter revision'
};
const reasonLabel = (r: string) => REASON_LABELS[r] ?? 'Saved version';

const FRIENDLY: Record<string, string> = {
  NOT_FOUND: 'This section could not be found. It may have been removed.',
  WRONG_RELATIONSHIP: "This section doesn't belong to the current book or chapter.",
  VERSION_NOT_FOUND: 'That saved version could not be found for this section.',
  LIST_FAILED: "We couldn't load the version history. Please try again.",
  SNAPSHOT_FAILED: "We couldn't safely save your current version first, so nothing was changed. Please try again.",
  UPDATE_FAILED: "Your current version was saved, but the restore didn't finish. Nothing was lost — please try again.",
  BAD_REQUEST: 'That version has no content to restore.'
};

function formatWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: iso, time: '' };
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  };
}

export function SectionVersionHistory({
  bookId,
  chapterId,
  sectionId,
  onRestored
}: {
  bookId: string;
  chapterId: string;
  sectionId: string;
  onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'list' | 'review' | 'done'>('list');
  const [list, setList] = useState<ListResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetChanged, setTargetChanged] = useState(false);

  function reset() {
    setStep('list'); setList(null); setSelectedId(null); setPreview(null);
    setBusy(false); setError(null); setTargetChanged(false);
  }
  function close() { setOpen(false); reset(); }

  async function openHistory() {
    setOpen(true); reset(); setBusy(true);
    try {
      const res = await fetch('/api/sections/versions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, section_id: sectionId })
      });
      const j = (await res.json()) as ListResult;
      if (j.status === 'ok') setList(j);
      else setError(FRIENDLY[j.status] ?? 'Could not load version history. Please try again.');
    } catch { setError('Could not load version history. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doPreview(versionId: string) {
    setSelectedId(versionId); setBusy(true); setError(null); setTargetChanged(false);
    try {
      const res = await fetch('/api/sections/preview-restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, section_id: sectionId, version_id: versionId })
      });
      const p = (await res.json()) as RestorePreview;
      if (p.status === 'changed' || p.status === 'UNCHANGED') { setPreview(p); setStep('review'); }
      else setError(FRIENDLY[p.status] ?? 'Could not compare versions. Please try again.');
    } catch { setError('Could not compare versions. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doRestore() {
    if (!selectedId || !preview?.current) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/sections/apply-restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId, chapter_id: chapterId, section_id: sectionId, version_id: selectedId,
          expected_content_hash: preview.current.content_hash, expected_updated_at: preview.current.updated_at
        })
      });
      const r = (await res.json()) as { status: string };
      if (r.status === 'applied') { setStep('done'); onRestored(); }
      else if (r.status === 'TARGET_CHANGED') { setTargetChanged(true); setError('This section changed after you opened the comparison. Refresh the comparison before restoring.'); }
      else setError(FRIENDLY[r.status] ?? 'Could not restore this version. Please try again.');
    } catch { setError('Could not restore this version. Please try again.'); }
    finally { setBusy(false); }
  }

  const btn = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-sm font-semibold transition';
  const versions = list?.versions ?? [];

  return (
    <>
      <button
        onClick={openHistory}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-ink-soft transition hover:text-accent-strong"
      >
        ↻ Version history
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" onClick={close}>
          <div
            className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-[0_-8px_40px_rgba(27,23,23,0.2)] sm:max-w-4xl sm:rounded-2xl sm:shadow-[0_12px_48px_rgba(27,23,23,0.2)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* header (close always visible) */}
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="font-display text-xl text-ink">Version History</h2>
                <p className="mt-0.5 truncate text-xs text-ink-faint">
                  {step === 'review' ? 'Compare, then restore if you choose' : 'Saved versions of this section'}
                </p>
              </div>
              <button onClick={close} aria-label="Close" className="-mr-1 rounded-lg p-2 text-ink-soft transition hover:bg-paper-sunken">✕</button>
            </div>

            {/* body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {error && (
                <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>
              )}

              {step === 'list' && (
                <div>
                  {/* Live current version — clearly not a snapshot, not restorable */}
                  {list?.current && (
                    <div className="mb-4 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-accent-strong">Current version</p>
                        <span className="text-xs text-ink-soft">{list.current.word_count} words · in the editor now</span>
                      </div>
                    </div>
                  )}

                  {busy && !list && <p className="py-8 text-center text-sm text-ink-faint">Loading version history…</p>}

                  {list && versions.length === 0 && (
                    <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                      <p className="font-display text-lg text-ink">No saved versions yet</p>
                      <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
                        A version is saved automatically whenever you upload a new version or restore an older one. Once you do, earlier versions of this section will appear here.
                      </p>
                    </div>
                  )}

                  {versions.length > 0 && (
                    <ul className="space-y-2">
                      {versions.map((v) => {
                        const when = formatWhen(v.created_at);
                        return (
                          <li key={v.id}>
                            <button
                              onClick={() => doPreview(v.id)}
                              disabled={busy}
                              className="flex w-full flex-col gap-1 rounded-xl border border-line bg-paper px-4 py-3 text-left transition hover:border-accent disabled:opacity-50"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                                <span className="font-display text-base text-ink">{reasonLabel(v.version_reason)}</span>
                                <span className="text-xs text-ink-faint">{when.date}{when.time ? ` · ${when.time}` : ''}</span>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-ink-soft">
                                <span>{v.word_count} words</span>
                                <span className="text-ink-faint">·</span>
                                <span className="min-w-0 truncate italic text-ink-faint">{v.excerpt || '(empty)'}</span>
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
                  <p className="font-display text-lg text-ink">This version matches the current section</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">There's nothing to restore — it's identical to what's in the editor now.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'changed' && (
                <div>
                  {targetChanged && (
                    <div className="mb-3 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">
                      This section changed after you opened the comparison. <button onClick={() => selectedId && doPreview(selectedId)} className="font-semibold underline">Refresh comparison</button> to review the latest before restoring.
                    </div>
                  )}
                  {preview.selected && (
                    <p className="mb-3 text-xs text-ink-faint">
                      Selected version saved {formatWhen(preview.selected.created_at).date} · {formatWhen(preview.selected.created_at).time} — {reasonLabel(preview.selected.version_reason)}
                    </p>
                  )}
                  <SectionVersionDiff
                    diff={preview.diff ?? []}
                    wordBefore={preview.word_count_before ?? 0}
                    wordAfter={preview.word_count_after ?? 0}
                    summary={preview.summary ?? { paragraphs_added: 0, paragraphs_removed: 0, paragraphs_unchanged: 0 }}
                    beforeLabel="Current version"
                    afterLabel="Selected version"
                  />
                  <p className="mt-4 text-sm text-ink-soft">
                    Restoring makes the selected version the current section. Your current content will first be saved to Version History, so you can undo this.
                  </p>
                </div>
              )}

              {step === 'done' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                  <p className="font-display text-xl text-ink">Version restored</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">The section now shows the restored version. The version you had before is saved in Version History.</p>
                </div>
              )}
            </div>

            {/* footer actions */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {step === 'list' && (
                <button onClick={close} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Close</button>
              )}
              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <button onClick={() => { setStep('list'); setPreview(null); setSelectedId(null); }} className={`${btn} border border-line text-ink hover:border-accent`}>Back to versions</button>
              )}
              {step === 'review' && preview?.status === 'changed' && (
                <>
                  <button onClick={() => { setStep('list'); setPreview(null); setSelectedId(null); setTargetChanged(false); setError(null); }} className={`${btn} text-ink-soft hover:bg-paper-sunken`}>Back</button>
                  <button onClick={doRestore} disabled={busy} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Restoring…' : 'Restore this version'}</button>
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
