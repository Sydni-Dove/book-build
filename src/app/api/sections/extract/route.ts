import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { extractText } from '@/lib/ingest/extractText';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = /\.(docx|txt|md)$/i;

// Server-side extraction for an uploaded file (docx needs it; txt/md too, so
// one path). Returns plain text; never touches the manuscript.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    file = form.get('file') as File | null;
  } catch {
    return NextResponse.json({ error: "That upload couldn't be read. Try again." }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: 'No file was provided.' }, { status: 400 });
  if (!ALLOWED.test(file.name)) return NextResponse.json({ error: 'Unsupported file type. Please upload a .docx, .txt, or .md file.' }, { status: 415 });

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = extractText({ bytes, filename: file.name });
    if (!text.trim()) return NextResponse.json({ error: "We couldn't read any text from that file." }, { status: 422 });
    return NextResponse.json({ text, filename: file.name });
  } catch {
    return NextResponse.json({ error: "We couldn't read that file. Try a different file or paste the text instead." }, { status: 422 });
  }
}
