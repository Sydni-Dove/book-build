'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBook } from '@/components/layout/BookContext';

/**
 * Mobile requirement from the spec: manuscript full-width, chapter nav as a
 * drawer, AI as a bottom sheet. This owns the bottom tab bar + the
 * chapter/story-canon drawer; the AI sheet's open state lives in
 * BookContext so any page's <AIPanel> can read it without prop drilling.
 */
export function MobileNav() {
  const { book, chapters, setAiSheetOpen } = useBook();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const base = `/books/${book.id}`;
  const onChapterPage = pathname?.includes(`${base}/chapters/`);

  return (
    <>
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDrawerOpen(false)} />
          <div className="relative z-10 flex h-full w-[82%] max-w-xs flex-col overflow-y-auto border-r border-line bg-surface p-4">
            <div className="mb-4 flex items-center justify-between">
              <p className="truncate font-display text-lg text-ink">{book.title}</p>
              <button onClick={() => setDrawerOpen(false)} className="rounded-md p-1.5 text-ink-soft hover:bg-black/5" aria-label="Close">
                ✕
              </button>
            </div>
            <Link href={`${base}/chapters`} onClick={() => setDrawerOpen(false)} className="mb-1 block rounded-md px-3 py-2 font-medium text-ink hover:bg-black/5">
              Manuscript
            </Link>
            <Link href={`${base}/working-notes`} onClick={() => setDrawerOpen(false)} className="mb-1 block rounded-md px-3 py-2 font-medium text-ink hover:bg-black/5">
              Working Notes
            </Link>
            <Link href={`${base}/review`} onClick={() => setDrawerOpen(false)} className="mb-1 block rounded-md px-3 py-2 font-medium text-ink hover:bg-black/5">
              Review &amp; Continuity
            </Link>
            <Link href={`${base}/plan`} onClick={() => setDrawerOpen(false)} className="mb-3 block rounded-md px-3 py-2 font-medium text-ink hover:bg-black/5">
              Plan
            </Link>
            <Link href={`${base}/import`} onClick={() => setDrawerOpen(false)} className="mb-1 block rounded-md px-3 py-2 font-medium text-ink hover:bg-black/5">
              Import
            </Link>
            <Link href={`${base}/versions`} onClick={() => setDrawerOpen(false)} className="mb-1 block rounded-md px-3 py-2 font-medium text-ink hover:bg-black/5">
              Versions
            </Link>
            <Link href={`${base}/tools`} onClick={() => setDrawerOpen(false)} className="mb-3 block rounded-md px-3 py-2 font-medium text-ink hover:bg-black/5">
              Tools
            </Link>
            <p className="mb-1 px-3 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Story Canon</p>
            {[
              ['Characters', 'story-canon/characters'],
              ['Settings', 'story-canon/locations'],
              ['Relationships', 'story-canon/relationships'],
              ['Story Threads', 'story-canon/story-threads'],
              ['Canon Facts', 'story-canon/canon'],
              ['Timeline', 'story-canon/timeline']
            ].map(([label, href]) => (
              <Link key={href} href={`${base}/${href}`} onClick={() => setDrawerOpen(false)} className="block rounded-md px-3 py-1.5 text-ink-soft hover:bg-black/5">
                {label}
              </Link>
            ))}
            <p className="mb-1 mt-5 px-3 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Chapters</p>
            {chapters.map((c) => (
              <Link key={c.id} href={`${base}/chapters/${c.id}`} onClick={() => setDrawerOpen(false)} className="block truncate rounded-md px-3 py-1.5 text-ink-soft hover:bg-black/5">
                {c.chapter_number ? `${c.chapter_number}. ` : ''}
                {c.title}
              </Link>
            ))}
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
        <button onClick={() => setDrawerOpen(true)} className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs text-ink-soft">
          <span className="text-base">☰</span>Chapters
        </button>
        <Link href={`${base}/chapters`} className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs text-ink-soft">
          <span className="text-base">✎</span>Write
        </Link>
        <Link href={`${base}/plan`} className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs text-ink-soft">
          <span className="text-base">◆</span>Plan
        </Link>
        <Link href={`${base}/story-canon/characters`} className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs text-ink-soft">
          <span className="text-base">📖</span>Story
        </Link>
        {onChapterPage && (
          <button onClick={() => setAiSheetOpen(true)} className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs text-accent-strong">
            <span className="text-base">✦</span>AI
          </button>
        )}
      </nav>
    </>
  );
}
