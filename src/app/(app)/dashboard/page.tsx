'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { HomeView } from '@/components/dashboard/HomeView';
import type { Book } from '@/lib/types/database';

export default function DashboardPage() {
  const supabase = createClient();
  const router = useRouter();
  const [books, setBooks] = useState<Book[] | null>(null);

  useEffect(() => {
    supabase
      .from('books')
      .select('*')
      .order('updated_at', { ascending: false })
      .then(({ data }) => setBooks(data ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(mode: 'new' | 'import', title: string) {
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) return router.push('/login');
    const { data, error } = await supabase
      .from('books')
      .insert({ user_id: user.id, title, status: 'Planning' })
      .select()
      .single();
    if (error || !data) return;
    // New Book → straight into the manuscript. Import → the book's import screen
    // (the real, Supabase-backed import surface — never buried in settings).
    router.push(mode === 'import' ? `/books/${data.id}/import` : `/books/${data.id}/chapters`);
  }

  async function onSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return <HomeView books={books} onCreate={onCreate} onSignOut={onSignOut} />;
}
