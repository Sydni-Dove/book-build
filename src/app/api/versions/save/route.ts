import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { snapshotManuscript } from '@/lib/versions/snapshot';

// "Save Version" — a deliberate, author-named whole-book checkpoint. This is
// the only user-facing entry into snapshotManuscript; autosave never reaches
// here. RLS (through createServerSupabase) guarantees the book is the
// caller's, so a stolen bookId can't snapshot someone else's manuscript.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { bookId, name, description } = (await request.json()) as {
    bookId: string;
    name?: string;
    description?: string;
  };

  if (!bookId) return NextResponse.json({ error: 'Missing book' }, { status: 400 });
  const trimmedName = (name ?? '').trim();
  if (!trimmedName) return NextResponse.json({ error: 'Give this version a name.' }, { status: 400 });

  // Confirm ownership explicitly (also gives a clean 404 rather than a
  // confusing RLS insert failure if the book isn't the caller's).
  const { data: book } = await supabase.from('books').select('id').eq('id', bookId).maybeSingle();
  if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });

  try {
    const version = await snapshotManuscript(supabase, {
      bookId,
      name: trimmedName,
      description: (description ?? '').trim() || null,
      reason: 'manual_snapshot',
      userId: user.id
    });
    return NextResponse.json({ version });
  } catch (err) {
    console.error('versions/save failed', err);
    return NextResponse.json({ error: 'Could not save this version. Nothing was changed — try again.' }, { status: 500 });
  }
}
