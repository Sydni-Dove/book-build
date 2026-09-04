'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Book } from '@/lib/types/database';
import { StatusPill } from '@/components/ui';

// Presentational Home / library. The prototype has no dashboard screen, so this
// is designed in its visual language (Playfair headings, burgundy accents, paper
// ground, restrained borders + soft shadow) rather than copied. Import Manuscript
// and New Book are the two primary, equally-weighted entry points — never buried.
// Desktop uses real width (wide container, up-to-3-column library); mobile stacks.

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type Mode = 'new' | 'import' | null;

export function HomeView({
  books,
  onCreate,
  onSignOut
}: {
  books: Book[] | null;
  onCreate: (mode: 'new' | 'import', title: string) => void;
  onSignOut: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  function submit() {
    const t = title.trim();
    if (!t || !mode || busy) return;
    setBusy(true);
    onCreate(mode, t);
  }
  function close() {
    setMode(null);
    setTitle('');
    setBusy(false);
  }

  return (
    <div className="min-h-dvh bg-paper">
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
        {/* Top bar */}
        <div className="mb-9 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-xl text-accent-strong">Book Build</span>
            <span className="hidden text-xs text-ink-faint sm:inline">by Dove Expressions</span>
          </div>
          <button
            onClick={onSignOut}
            className="rounded-lg px-3 py-2 text-sm text-ink-faint transition hover:bg-paper-sunken hover:text-accent-strong"
          >
            Sign out
          </button>
        </div>

        {/* Hero */}
        <div className="mb-4">
          <h1 className="font-display text-3xl text-ink sm:text-4xl">Your writing studio</h1>
          <p className="mt-2 max-w-xl text-[15px] leading-7 text-ink-soft">
            Start something new, or bring in a manuscript you&apos;ve already begun. Book Build helps you
            develop it section by section — you stay the author.
          </p>
        </div>

        {/* Two primary entry points */}
        <div className="mb-12 grid gap-4 md:grid-cols-2">
          <div className="flex flex-col justify-between rounded-2xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(27,23,23,0.04)] transition hover:border-accent-soft-strong">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Begin</p>
              <h2 className="mt-1.5 font-display text-2xl text-ink">Start a new book</h2>
              <p className="mt-2 text-sm leading-6 text-ink-soft">
                Open a blank manuscript and build it chapter by chapter, with development help along the way.
              </p>
            </div>
            <button
              onClick={() => setMode('new')}
              className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-[#F6F3EC] transition hover:bg-accent-strong"
            >
              New Book
            </button>
          </div>

          <div className="flex flex-col justify-between rounded-2xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(27,23,23,0.04)] transition hover:border-accent-soft-strong">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Bring it in</p>
              <h2 className="mt-1.5 font-display text-2xl text-ink">Import a manuscript</h2>
              <p className="mt-2 text-sm leading-6 text-ink-soft">
                Already have a draft in Word or elsewhere? Import it and pick up right where you left off.
              </p>
            </div>
            <button
              onClick={() => setMode('import')}
              className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-accent bg-surface px-5 py-3 text-sm font-semibold text-accent-strong transition hover:bg-accent-soft"
            >
              Import Manuscript
            </button>
          </div>
        </div>

        {/* Library */}
        <div className="mb-4 flex items-baseline justify-between">
          <h3 className="font-display text-lg text-ink">Your books</h3>
          {books && books.length > 0 && (
            <span className="text-xs text-ink-faint">{books.length} {books.length === 1 ? 'book' : 'books'}</span>
          )}
        </div>

        {books === null ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : books.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
            <p className="font-display text-lg text-ink">No books yet</p>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-soft">
              Start a new book or import a manuscript above to open your first workspace.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {books.map((b) => (
              <Link
                key={b.id}
                href={`/books/${b.id}/chapters`}
                className="group flex min-h-[150px] flex-col rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(27,23,23,0.04)] transition hover:border-accent hover:shadow-[0_4px_16px_rgba(27,23,23,0.08)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-display text-lg leading-snug text-ink">{b.title}</p>
                  <StatusPill status={b.status} />
                </div>
                {(b.subtitle || b.genre) && (
                  <p className="mt-1 text-sm text-ink-soft">{b.subtitle || b.genre}</p>
                )}
                {b.description && (
                  <p className="mt-2 line-clamp-2 text-[13px] leading-6 text-ink-faint">{b.description}</p>
                )}
                <p className="mt-auto pt-4 text-xs text-ink-faint">Updated {relativeDate(b.updated_at)}</p>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Create / import modal */}
      {mode && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 p-4 sm:items-center" onClick={close}>
          <div
            className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-[0_12px_40px_rgba(27,23,23,0.2)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-xl text-ink">
              {mode === 'new' ? 'Name your new book' : 'Import a manuscript'}
            </h3>
            <p className="mt-1 text-sm leading-6 text-ink-soft">
              {mode === 'new'
                ? 'You can change the title, genre, and details later in book settings.'
                : 'Give the book a title first — then you&apos;ll add the manuscript file on the next screen.'}
            </p>
            <label className="mt-4 block">
              <span className="mb-1 block text-sm font-medium text-ink">Book title</span>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="e.g. Awakened"
                className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-base text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={close}
                className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-ink-soft transition hover:bg-paper-sunken"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!title.trim() || busy}
                className="min-h-[44px] rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-[#F6F3EC] transition hover:bg-accent-strong disabled:opacity-50"
              >
                {busy ? 'Working…' : mode === 'new' ? 'Create book' : 'Continue to import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
