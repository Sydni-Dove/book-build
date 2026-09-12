import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { ExtractionError, extractText } from '@/lib/ingest/extractText';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = /\.(docx|txt|md)$/i;

function extractionMessage(error: unknown): string {
  if (!(error instanceof ExtractionError)) {
    return "We couldn't read that file. Try a different file or paste the text instead.";
  }

  switch (error.code) {
    case 'EMPTY_DOCUMENT':
      return "We couldn't find any readable manuscript text in that Word file.";
    case 'INVALID_DOCX':
    case 'DOCX_XML_MISSING':
      return "That Word file doesn't appear to be a valid .docx document. Try saving it again as Word (.docx) and re-uploading it.";
    case 'DOCX_COMPRESSION_UNSUPPORTED':
    case 'DOCX_DECOMPRESSION_FAILED':
      return "We couldn't unpack that Word file. Try saving a fresh .docx copy and upload it again.";
    default:
      return "We couldn't read that file. Try a different file or paste the text instead.";
  }
}

// Server-side extraction for an uploaded file. Returns plain text only and
// never changes manuscript/chapter data; comparison remains a separate step.
export async function POST(request: Request) {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    file = candidate instanceof File ? candidate : null;
  } catch (error) {
    console.error('[file-extract] form-data read failed', error);
    return NextResponse.json({ error: "That upload couldn't be read. Try again." }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: 'No file was provided.' }, { status: 400 });
  if (!ALLOWED.test(file.name)) {
    return NextResponse.json({ error: 'Unsupported file type. Please upload a .docx, .txt, or .md file.' }, { status: 415 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.byteLength) {
      return NextResponse.json({ error: 'That file is empty.' }, { status: 422 });
    }

    const text = extractText({ bytes, filename: file.name });
    if (!text.trim()) {
      return NextResponse.json({ error: "We couldn't read any text from that file." }, { status: 422 });
    }

    return NextResponse.json({ text, filename: file.name });
  } catch (error) {
    console.error('[file-extract] extraction failed', {
      filename: file.name,
      size: file.size,
      code: error instanceof ExtractionError ? error.code : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error)
    });
    return NextResponse.json({ error: extractionMessage(error) }, { status: 422 });
  }
}
