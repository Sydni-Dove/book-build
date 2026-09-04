'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useBook } from '@/components/layout/BookContext';
import { Button, Card, StatusPill } from '@/components/ui';
import { BookManuscriptUpload } from '@/components/versions/BookManuscriptUpload';
import { BookManuscriptHistory } from '@/components/versions/BookManuscriptHistory';
import { RemovedChapters } from '@/components/versions/RemovedChapters';

export default function ChaptersPage() {
  const { book, chapters } = useBook();
  const supabase = createClient();
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  async function addChapter() {
    setCreating(true);
    // One transaction: next number/order computed server-side, serialized per
    // book (add_chapter_at_end) — no stale client max+1 race.
    const { data } = await supabase.rpc('add_chapter_at_end', { p_book_id: book.id, p_title: '' });
    setCreating(false);
    const newId = (data as { chapter_id?: string } | null)?.chapter_id;
    if (newId) router.push(`/books/${book.id}/chapters/${newId}`);
    router.refresh();
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= chapters.length) return;
    const a = chapters[index];
    const b = chapters[target];
    if (!a || !b) return;
    await Promise.all([
      supabase.from('chapters').update({ sort_order: b.sort_order }).eq('id', a.id),
      supabase.from('chapters').update({ sort_order: a.sort_order }).eq('id', b.id)
    ]);
    router.refresh();
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-8 sm:px-7 lg:px-10 xl:px-12">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="font-display text-2xl text-ink">Manuscript</p>
        <Button onClick={addChapter} disabled={creating}>
          + Add Chapter
        </Button>
      </div>
      {/* Whole-book version actions — updating the EXISTING manuscript, distinct
          from first-time "Import Manuscript". */}
      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-line pb-4">
        <BookManuscriptUpload bookId={book.id} onApplied={() => router.refresh()} />
        <span className="text-ink-faint" aria-hidden>·</span>
        <BookManuscriptHistory bookId={book.id} onRestored={() => router.refresh()} />
      </div>

      {chapters.length === 0 && (
        <p className="text-sm text-ink-faint">No chapters yet. Start your first one — you'll be writing section by section inside it.</p>
      )}

      <div className="w-full space-y-2">
        {chapters.map((c, i) => (
          <Card key={c.id} className="flex w-full items-center justify-between gap-3">
            <Link href={`/books/${book.id}/chapters/${c.id}`} className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink">
                {c.chapter_number ? `${c.chapter_number}. ` : ''}
                {c.title}
              </p>
              {c.summary && <p className="mt-0.5 line-clamp-1 text-sm text-ink-soft">{c.summary}</p>}
            </Link>
            <div className="shrink-0">
              <StatusPill status={c.status} />
            </div>
            <div className="flex flex-col">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-ink-faint hover:text-accent-strong disabled:opacity-30">
                ▲
              </button>
              <button onClick={() => move(i, 1)} disabled={i === chapters.length - 1} className="px-1 text-ink-faint hover:text-accent-strong disabled:opacity-30">
                ▼
              </button>
            </div>
          </Card>
        ))}
      </div>

      <RemovedChapters bookId={book.id} onChanged={() => router.refresh()} />
    </div>
  );
}
