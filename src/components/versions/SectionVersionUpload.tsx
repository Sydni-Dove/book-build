'use client';

import { useRef, useState } from 'react';
import { SectionVersionDiff } from '@/components/versions/SectionVersionDiff';

type Preview = {
  status: string;
  current?: { word_count: number; content_hash: string; updated_at?: string };
  incoming?: { word_count: number };
  word_count_before?: number;
  word_count_after?: number;
  summary?: { paragraphs_added: number; paragraphs_removed: number; paragraphs_unchanged: number };
  diff?: { kind: 'common' | 'removed' | 'added'; text: string }[];
};

const FRIENDLY: Record<string, string> = {
  NOT_FOUND: 'This section could not be found. It may have been removed.',
  WRONG_RELATIONSHIP: "This section doesn't belong to the current book or chapter.",
  SNAPSHOT_FAILED: "We couldn't safely save your current version first, so nothing was changed. Please try again.",
  UPDATE_FAILED: "Your previous version was saved, but the update didn't finish. Nothing was lost — please try again.",
  BAD_REQUEST: 'Please provide the new version text.'
};

export function SectionVersionUpload({
  bookId,
  chapterId,
  sectionId,
  onApplied
}: {
  bookId: string;
  chapterId: string;
  sectionId: string;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [incoming, setIncoming] = useState('');
  const [fileName, setFileName] = useState('');
  const [step, setStep] = useState<'input' | 'review' | 'done'>('input');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetChanged, setTargetChanged] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setMode('paste'); setIncoming(''); setFileName(''); setStep('input');
    setPreview(null); setBusy(false); setError(null); setTargetChanged(false);
  }
  function close() { setOpen(false); reset(); }

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
    } catch {
      setError('Something went wrong reading that file. Try pasting the text instead.');
    } finally { setBusy(false); }
  }

  async function doReview() {
    if (!incoming.trim()) { setError('Paste or upload the new version first.'); return; }
    setBusy(true); setError(null); setTargetChanged(false);
    try {
      const res = await fetch('/api/sections/preview-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, chapter_id: chapterId, section_id: sectionId, incoming_content: incoming })
      });
      const p = (await res.json()) as Preview;
      if (p.status === 'changed' || p.status === 'UNCHANGED') { setPreview(p); setStep('review'); }
      else setError(FRIENDLY[p.status] ?? 'Something went wrong. Please try again.');
    } catch { setError('Could not compare versions. Please try again.'); }
    finally { setBusy(false); }
  }

  async function doApply() {
    if (!preview?.current) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/sections/apply-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId, chapter_id: chapterId, section_id: sectionId,
          expected_content_hash: preview.current.content_hash, expected_updated_at: preview.current.updated_at, approved_content: incoming
        })
      });
      const r = (await res.json()) as { status: string };
      if (r.status === 'applied') { setStep('done'); onApplied(); }
      else if (r.status === 'TARGET_CHANGED') { setTargetChanged(true); setError('This section changed after you opened the comparison. Review the latest version before replacing it.'); }
      else setError(FRIENDLY[r.status] ?? 'Something went wrong. Please try again.');
    } catch { setError('Could not save the new version. Please try again.'); }
    finally { setBusy(false); }
  }

  const btn = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-sm font-semibold transition';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-soft transition hover:border-accent hover:text-accent-strong"
      >
        ⤒ Upload new version
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
                <h2 className="font-display text-xl text-ink">Upload New Version</h2>
                <p className="mt-0.5 truncate text-xs text-ink-faint">Updating the current section of this chapter</p>
              </div>
              <button onClick={close} aria-label="Close" className="-mr-1 rounded-lg p-2 text-ink-soft transition hover:bg-paper-sunken">✕</button>
            </div>

            {/* body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {error && (
                <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>
              )}

              {step === 'input' && (
                <div>
                  <div className="mb-4 inline-flex rounded-lg border border-line bg-paper p-1 text-sm">
                    {(['paste', 'file'] as const).map((m) => (
                      <button key={m} onClick={() => setMode(m)} className={`min-h-[36px] rounded-md px-3 font-medium transition ${mode === m ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:text-ink'}`}>
                        {m === 'paste' ? 'Paste new version' : 'Upload file'}
                      </button>
                    ))}
                  </div>

                  {mode === 'paste' ? (
                    <textarea
                      value={incoming}
                      onChange={(e) => setIncoming(e.target.value)}
                      placeholder="Paste the complete new version of this section…"
                      className="h-[46vh] w-full resize-none rounded-xl border border-line bg-white p-3 text-base leading-7 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                    />
                  ) : (
                    <div>
                      <button
                        onClick={() => fileRef.current?.click()}
                        className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-paper px-4 py-10 text-center transition hover:border-accent"
                      >
                        <span className="font-display text-lg text-ink">{fileName || 'Choose a file'}</span>
                        <span className="mt-1 text-sm text-ink-soft">Word (.docx), text (.txt), or Markdown (.md)</span>
                      </button>
                      <input ref={fileRef} type="file" accept=".docx,.txt,.md" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
                      {incoming && fileName && <p className="mt-3 text-xs text-ink-faint">Loaded “{fileName}” — {incoming.trim().split(/\s+/).length} words. Continue to review the changes.</p>}
                    </div>
                  )}
                </div>
              )}

              {step === 'review' && preview?.status === 'UNCHANGED' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-8 text-center">
                  <p className="font-display text-lg text-ink">No changes to save</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">This version matches the current section, so there's nothing to replace.</p>
                </div>
              )}

              {step === 'review' && preview?.status === 'changed' && (
                <div>
                  {targetChanged && (
                    <div className="mb-3 rounded-lg border border-sunrise/40 bg-sunrise-soft px-3 py-2 text-sm text-gold-strong">
                      This section changed after you opened the comparison. <button onClick={doReview} className="font-semibold underline">Refresh comparison</button> to review the latest before replacing.
                    </div>
                  )}
                  <SectionVersionDiff
                    diff={preview.diff ?? []}
                    wordBefore={preview.word_count_before ?? 0}
                    wordAfter={preview.word_count_after ?? 0}
                    summary={preview.summary ?? { paragraphs_added: 0, paragraphs_removed: 0, paragraphs_unchanged: 0 }}
                  />
                  <p className="mt-4 text-sm text-ink-soft">Your current version will be saved to Version History before the new version replaces it.</p>
                </div>
              )}

              {step === 'done' && (
                <div className="rounded-xl border border-line bg-paper px-4 py-10 text-center">
                  <p className="font-display text-xl text-ink">New version saved</p>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">Your previous version is in Version History.</p>
                </div>
              )}
            </div>

            {/* footer actions */}
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
                  <button onClick={doApply} disabled={busy} className={`${btn} bg-accent text-[#F6F3EC] hover:bg-accent-strong disabled:opacity-50`}>{busy ? 'Saving…' : 'Use new version'}</button>
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
