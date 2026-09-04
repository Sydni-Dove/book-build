'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type RemovedChapter = { id: string; title: string; chapter_number: number | null; archived_at: string | null; word_count: number; section_count: number; preview: string };

function formatRemoved(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Recovery surface for chapters removed from the active manuscript. They are NOT
// deleted (archived_at is set); restoring reactivates the SAME chapter_id with
// all its sections/history/scenes intact. No permanent-delete controls here.
export function RemovedChapters({ bookId, onChanged }: { bookId: string; onChanged: () => void }) {
  const supabase = createClient();
  const [removed, setRemoved] = useState<RemovedChapter[] | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: chs } = await supabase
      .from('chapters')
      .select('id, title, chapter_number, archived_at')
      .eq('book_id', bookId)
      .not('archived_at', 'is', null)
      .order('archived_at', { ascending: false });
    const list = chs ?? [];
    if (list.length === 0) { setRemoved([]); return; }
    const { data: secs } = await supabase
      .from('writing_sections')
      .select('chapter_id, content, word_count, sort_order')
      .in('chapter_id', list.map((c) => c.id))
      .order('sort_order', { ascending: true });
    const byChapter = new Map<string, { content: string; word_count: number }[]>();
    for (const s of secs ?? []) { const a = byChapter.get(s.chapter_id) ?? []; a.push({ content: s.content, word_count: s.word_count }); byChapter.set(s.chapter_id, a); }
    setRemoved(list.map((c) => {
      const cs = byChapter.get(c.id) ?? [];
      return {
        id: c.id, title: c.title, chapter_number: c.chapter_number, archived_at: c.archived_at,
        word_count: cs.reduce((n, s) => n + (s.word_count ?? 0), 0), section_count: cs.length,
        preview: (cs[0]?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      };
    }));
  }, [bookId, supabase]);

  useEffect(() => { load(); }, [load]);

  async function restore(id: string) {
    setBusyId(id); setError(null);
    try {
      // One atomic transaction: reactivate + place at end + renumber, all
      // computed server-side (reactivate_chapter_to_end). No client renumber.
      const { error: rErr } = await supabase.rpc('reactivate_chapter_to_end', { p_book_id: bookId, p_chapter_id: id });
      // ALREADY_ACTIVE (e.g. a double-click after it restored) is benign — just refresh.
      if (rErr && !/ALREADY_ACTIVE/.test(rErr.message)) { setError('Could not restore that chapter. Please try again.'); return; }
      await load();
      onChanged();
    } catch { setError('Could not restore that chapter. Please try again.'); }
    finally { setBusyId(null); }
  }

  if (!removed || removed.length === 0) return null; // no empty panel when there's nothing removed

  return (
    <div className="mt-8 border-t border-line pt-5">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="text-sm font-semibold text-ink-soft">Removed chapters ({removed.length})</span>
        <span className="text-xs text-ink-faint">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-3">
          <p className="mb-3 text-xs text-ink-faint">These chapters are not currently part of your manuscript, but their writing and history are preserved.</p>
          {error && <div className="mb-3 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}
          <ul className="space-y-2">
            {removed.map((c) => {
              const isOpen = expanded.has(c.id);
              return (
                <li key={c.id} className="rounded-xl border border-dashed border-line-strong bg-paper/60 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink-soft">{c.title || 'Untitled chapter'}</p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {c.section_count} section{c.section_count === 1 ? '' : 's'} · {c.word_count} words{c.archived_at ? ` · removed ${formatRemoved(c.archived_at)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {c.preview && (
                        <button onClick={() => setExpanded((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} className="min-h-[44px] rounded-lg border border-line px-3 text-xs font-medium text-ink-soft transition hover:border-accent">
                          {isOpen ? 'Hide' : 'Preview'}
                        </button>
                      )}
                      <button onClick={() => restore(c.id)} disabled={busyId === c.id} className="min-h-[44px] rounded-lg bg-accent px-4 text-xs font-semibold text-[#F6F3EC] transition hover:bg-accent-strong disabled:opacity-50">
                        {busyId === c.id ? 'Restoring…' : 'Restore to manuscript'}
                      </button>
                    </div>
                  </div>
                  {isOpen && c.preview && <p className="mt-3 rounded-lg bg-paper-sunken px-3 py-2 text-sm italic leading-6 text-ink-soft">“{c.preview}{c.preview.length >= 200 ? '…' : ''}”</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
