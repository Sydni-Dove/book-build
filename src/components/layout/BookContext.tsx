'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Book, Chapter } from '@/lib/types/database';

interface BookContextValue {
  book: Book;
  chapters: Chapter[];
  aiSheetOpen: boolean;
  setAiSheetOpen: (v: boolean) => void;
}

const BookContext = createContext<BookContextValue | null>(null);

export function BookProvider({
  book,
  chapters,
  children
}: {
  book: Book;
  chapters: Chapter[];
  children: ReactNode;
}) {
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  return <BookContext.Provider value={{ book, chapters, aiSheetOpen, setAiSheetOpen }}>{children}</BookContext.Provider>;
}

export function useBook() {
  const ctx = useContext(BookContext);
  if (!ctx) throw new Error('useBook must be used within a BookProvider');
  return ctx;
}
