'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Props = {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterNumber: number | null;
  chapterTitle: string;
  sectionId?: string;
};

function slug(s: string) {
  return (s || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportMenu({ bookId, bookTitle, chapterId, chapterNumber, chapterTitle, sectionId }: Props) {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const chapterHeading = (n: number | null, title: string) => `## ${n ? `Chapter ${n}` : 'Chapter'}${title ? `: ${title}` : ''}`;

  async function exportSection() {
    if (!sectionId) return;
    const { data } = await supabase.from('writing_sections').select('content').eq('id', sectionId).single();
    const body = `${chapterHeading(chapterNumber, chapterTitle)}\n\n${(data?.content ?? '').trim()}\n`;
    download(`${slug(bookTitle)}-ch${chapterNumber ?? ''}-section.md`, body);
  }

  async function exportChapter() {
    const { data } = await supabase.from('writing_sections').select('content, sort_order').eq('chapter_id', chapterId).order('sort_order', { ascending: true });
    const body = `${chapterHeading(chapterNumber, chapterTitle)}\n\n${(data ?? []).map((s) => (s.content ?? '').trim()).filter(Boolean).join('\n\n')}\n`;
    download(`${slug(bookTitle)}-chapter-${chapterNumber ?? 'x'}.md`, body);
  }

  async function exportManuscript() {
    const { data: chapters } = await supabase
      .from('chapters').select('id, chapter_number, title, sort_order')
      .eq('book_id', bookId).is('archived_at', null).order('sort_order', { ascending: true });
    const chs = chapters ?? [];
    const ids = chs.map((c) => c.id);
    const { data: sections } = ids.length
      ? await supabase.from('writing_sections').select('chapter_id, content, sort_order').in('chapter_id', ids)
      : { data: [] };
    const byCh = new Map<string, { sort_order: number; content: string }[]>();
    for (const s of (sections ?? [])) { const a = byCh.get(s.chapter_id) ?? []; a.push({ sort_order: s.sort_order, content: s.content ?? '' }); byCh.set(s.chapter_id, a); }
    const parts = chs.map((c) => {
      const secs = (byCh.get(c.id) ?? []).sort((a, b) => a.sort_order - b.sort_order).map((s) => s.content.trim()).filter(Boolean).join('\n\n');
      return `${chapterHeading(c.chapter_number, c.title)}\n\n${secs}`;
    });
    download(`${slug(bookTitle)}-manuscript.md`, `# ${bookTitle}\n\n${parts.join('\n\n---\n\n')}\n`);
  }

  async function exportNotes() {
    const { data } = await supabase
      .from('working_notes').select('title, content, note_type, status, created_at')
      .eq('book_id', bookId).eq('status', 'active').order('created_at', { ascending: true });
    const notes = data ?? [];
    const body = notes.length
      ? notes.map((n) => `## ${n.title || 'Untitled note'} (${n.note_type})\n\n${(n.content ?? '').trim()}`).join('\n\n---\n\n')
      : '_No working notes yet._';
    download(`${slug(bookTitle)}-working-notes.md`, `# ${bookTitle} — Working Notes\n\n${body}\n`);
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); } catch { /* swallow — nothing is mutated */ }
    finally { setBusy(null); setOpen(false); }
  }

  const items: { key: string; label: string; fn: () => Promise<void>; disabled?: boolean }[] = [
    { key: 'section', label: 'This section', fn: exportSection, disabled: !sectionId },
    { key: 'chapter', label: 'This chapter', fn: exportChapter },
    { key: 'manuscript', label: 'Whole manuscript', fn: exportManuscript },
    { key: 'notes', label: 'Working notes', fn: exportNotes }
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-soft transition hover:border-accent hover:text-accent-strong"
      >
        {busy ? 'Exporting…' : '↧ Export ▾'}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() => run(it.key, it.fn)}
              disabled={it.disabled || !!busy}
              className="block w-full px-3 py-2 text-left text-sm text-ink transition hover:bg-black/5 disabled:cursor-not-allowed disabled:text-ink-faint"
            >
              {it.label}
            </button>
          ))}
          <p className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">Downloads a Markdown (.md) file.</p>
        </div>
      )}
    </div>
  );
}
