'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBook } from '@/components/layout/BookContext';

const STORY_CANON_LINKS = [
  { href: 'story-canon/characters', label: 'Characters' },
  { href: 'story-canon/locations', label: 'Settings' },
  { href: 'story-canon/relationships', label: 'Relationships' },
  { href: 'story-canon/story-threads', label: 'Story Threads' },
  { href: 'story-canon/canon', label: 'Canon Facts' },
  { href: 'story-canon/timeline', label: 'Timeline' }
];

export function Sidebar() {
  const { book, chapters } = useBook();
  const pathname = usePathname();
  const base = `/books/${book.id}`;
  const isActive = (href: string) => pathname?.startsWith(`${base}/${href}`);

  return (
    <aside className="hidden w-64 shrink-0 flex-col self-start border-r border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh">
      <div className="border-b border-line px-4 py-4">
        <Link href="/dashboard" className="text-xs text-ink-faint hover:text-accent-strong">
          ← All books
        </Link>
        <p className="mt-1 truncate font-display text-lg text-ink">{book.title}</p>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 text-sm">
        <Link
          href={`${base}/chapters`}
          className={`mb-1 block rounded-md px-3 py-2 font-medium ${
            pathname === `${base}/chapters` ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-black/5'
          }`}
        >
          Manuscript
        </Link>
        <Link
          href={`${base}/working-notes`}
          className={`mb-1 block rounded-md px-3 py-2 font-medium ${
            isActive('working-notes') ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-black/5'
          }`}
        >
          Working Notes
        </Link>
        <Link
          href={`${base}/review`}
          className={`mb-1 block rounded-md px-3 py-2 font-medium ${
            isActive('review') ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-black/5'
          }`}
        >
          Review &amp; Continuity
        </Link>
        <Link
          href={`${base}/plan`}
          className={`mb-1 block rounded-md px-3 py-2 font-medium ${
            isActive('plan') ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-black/5'
          }`}
        >
          Plan
        </Link>
        <Link
          href={`${base}/import`}
          className={`mb-1 block rounded-md px-3 py-2 font-medium ${
            isActive('import') ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-black/5'
          }`}
        >
          Import
        </Link>
        <Link
          href={`${base}/versions`}
          className={`mb-1 block rounded-md px-3 py-2 font-medium ${
            isActive('versions') ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-black/5'
          }`}
        >
          Versions
        </Link>
        <Link
          href={`${base}/tools`}
          className={`mb-1 block rounded-md px-3 py-2 font-medium ${
            isActive('tools') ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-black/5'
          }`}
        >
          Tools
        </Link>

        <p className="mb-1 mt-4 px-3 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Story Canon</p>
        {STORY_CANON_LINKS.map((l) => (
          <Link
            key={l.href}
            href={`${base}/${l.href}`}
            className={`mb-0.5 block rounded-md px-3 py-1.5 ${
              isActive(l.href) ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-black/5 hover:text-ink'
            }`}
          >
            {l.label}
          </Link>
        ))}

        <p className="mb-1 mt-5 px-3 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Chapters</p>
        <div className="space-y-0.5">
          {chapters.map((c) => (
            <Link
              key={c.id}
              href={`${base}/chapters/${c.id}`}
              className={`block truncate rounded-md px-3 py-1.5 ${
                pathname === `${base}/chapters/${c.id}` ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-black/5 hover:text-ink'
              }`}
            >
              {c.chapter_number ? `${c.chapter_number}. ` : ''}
              {c.title}
            </Link>
          ))}
        </div>
      </nav>

      <div className="border-t border-line px-4 py-3">
        <Link href={`${base}/settings`} className="text-xs text-ink-faint hover:text-accent-strong">
          Book settings & AI controls
        </Link>
      </div>
    </aside>
  );
}
