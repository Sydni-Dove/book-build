import { notFound } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { BookShell } from '@/components/layout/BookShell';

export default async function BookLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: { bookId: string };
}) {
  const supabase = createServerSupabase();

  const [{ data: book }, { data: chapters }] = await Promise.all([
    supabase.from('books').select('*').eq('id', params.bookId).single(),
    supabase.from('chapters').select('*').eq('book_id', params.bookId).is('archived_at', null).order('sort_order', { ascending: true })
  ]);

  if (!book) notFound();

  return (
    <BookShell book={book} chapters={chapters ?? []}>
      {children}
    </BookShell>
  );
}
