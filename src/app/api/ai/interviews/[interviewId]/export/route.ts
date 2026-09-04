import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

type ExportParams = {
  params: {
    interviewId: string;
  };
};

function formatStoredDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function safeFileName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function interviewLabel(type: string) {
  const labels: Record<string, string> = {
    development: 'Development Interview',
    setting: 'Setting Interview',
    character: 'Character Interview',
    continuity_fix: 'Continuity Fix Interview',
    continue: 'Before You Continue Interview',
    plan_new_book: 'Build My Story Interview',
    plan_chapter: 'Plan This Chapter Interview'
  };
  return labels[type] ?? 'AI Interview';
}

export async function GET(_request: Request, { params }: ExportParams) {
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: interview } = await supabase
    .from('ai_interviews')
    .select('*')
    .eq('id', params.interviewId)
    .single();

  if (!interview) return NextResponse.json({ error: 'Interview not found' }, { status: 404 });

  const [{ data: book }, { data: chapter }, { data: section }, { data: workingNote }, { data: messages }] = await Promise.all([
    supabase.from('books').select('title').eq('id', interview.book_id).single(),
    interview.chapter_id
      ? supabase.from('chapters').select('chapter_number,title').eq('id', interview.chapter_id).single()
      : Promise.resolve({ data: null }),
    interview.section_id
      ? supabase.from('writing_sections').select('title,sort_order').eq('id', interview.section_id).single()
      : Promise.resolve({ data: null }),
    interview.working_note_id
      ? supabase.from('working_notes').select('title,note_type,status').eq('id', interview.working_note_id).single()
      : Promise.resolve({ data: null }),
    supabase
      .from('ai_interview_messages')
      .select('role,content,created_at')
      .eq('interview_id', params.interviewId)
      .order('created_at', { ascending: true })
  ]);

  const lines: string[] = [
    `# ${interviewLabel(interview.interview_type)}`,
    '',
    `Book: ${book?.title ?? 'Untitled book'}`,
    `Interview type: ${interviewLabel(interview.interview_type)}`,
    `Status: ${interview.status}`
  ];

  if (interview.topic) lines.push(`Topic: ${interview.topic}`);
  if (chapter) {
    const chapterLabel = chapter.chapter_number ? `Chapter ${chapter.chapter_number}` : 'Chapter';
    lines.push(`Chapter: ${chapter.title ? `${chapterLabel}: ${chapter.title}` : chapterLabel}`);
  }
  if (section) {
    const sectionLabel = section.sort_order !== null && section.sort_order !== undefined
      ? `Section ${section.sort_order + 1}`
      : 'Section';
    lines.push(`Section: ${section.title ? `${sectionLabel}: ${section.title}` : sectionLabel}`);
  }
  if (workingNote) {
    lines.push(`Working note: ${workingNote.title || 'Untitled note'} (${workingNote.note_type}, ${workingNote.status})`);
    lines.push('Working note boundary: non-canonical material, not manuscript prose or Story Canon.');
  }

  const startedAt = formatStoredDate(interview.created_at);
  const updatedAt = formatStoredDate(interview.updated_at);
  if (startedAt) lines.push(`Started: ${startedAt}`);
  if (updatedAt) lines.push(`Last updated: ${updatedAt}`);

  lines.push('', '## Conversation', '');

  if (messages?.length) {
    messages.forEach((message, index) => {
      const speaker = message.role === 'assistant' ? 'Editor' : 'You';
      const sentAt = formatStoredDate(message.created_at);
      lines.push(`### ${index + 1}. ${speaker}${sentAt ? ` - ${sentAt}` : ''}`, '', message.content.trim(), '');
    });
  } else {
    lines.push('No saved messages yet.', '');
  }

  const baseName = safeFileName(`${book?.title ?? 'book'}-${interview.interview_type}-interview`) || 'book-build-interview';

  return NextResponse.json({
    fileName: `${baseName}.md`,
    contentType: 'text/markdown;charset=utf-8',
    content: lines.join('\n')
  });
}
