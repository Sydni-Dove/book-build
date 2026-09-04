'use client';

import { BookProvider } from '@/components/layout/BookContext';
import { Sidebar } from '@/components/layout/Sidebar';
import { MobileNav } from '@/components/layout/MobileNav';
import type { Book, Chapter } from '@/lib/types/database';

export function BookShell({
  book,
  chapters,
  children
}: {
  book: Book;
  chapters: Chapter[];
  children: React.ReactNode;
}) {
  return (
    <BookProvider book={book} chapters={chapters}>
      <div className="flex min-h-dvh">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col pb-16 lg:pb-0">{children}</div>
        <MobileNav />
      </div>
    </BookProvider>
  );
}
