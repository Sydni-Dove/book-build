import Link from 'next/link';
import { Card, StatusPill } from '@/components/ui';
import { createServerSupabase } from '@/lib/supabase/server';

const TOOL_GROUPS = [
  {
    title: 'Writing',
    tools: [
      ['Help Me Continue', 'Live', 'Ask focused pre-writing questions from chapter context.'],
      ['Develop This', 'Live', 'Interview a rough idea into development notes.'],
      ['Describe This', 'Staged', 'Setting, character, object, and atmosphere prompts are schema-ready.']
    ]
  },
  {
    title: 'Review',
    tools: [
      ['Review Section', 'Staged', 'Section-review prompt and tables exist.'],
      ['Chapter Review', 'Staged', 'Chapter-review prompt is ready for a route and screen.'],
      ['Continuity Check', 'Staged', 'Conflict detection has schema and prompt support.']
    ]
  },
  {
    title: 'Planning',
    tools: [
      ['Build My Story', 'Live', 'Book-level interview, plot possibilities, and outline persistence.'],
      ['Plan This Chapter', 'Live', 'Chapter recap, interview, scenes, and beat editor.'],
      ['Fix With Me', 'Staged', 'Revision workflow is designed and tied to section version snapshots.']
    ]
  }
] as const;

export default async function ToolsPage({ params }: { params: { bookId: string } }) {
  const supabase = createServerSupabase();
  const { data: chapters } = await supabase
    .from('chapters')
    .select('id')
    .eq('book_id', params.bookId)
    .is('archived_at', null)
    .order('sort_order', { ascending: true })
    .limit(1);
  const firstChapterId = chapters?.[0]?.id;

  return (
    <div className="mx-auto max-w-4xl px-5 py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Tools</p>
          <h1 className="mt-1 font-display text-2xl text-ink">Feature Map</h1>
        </div>
        <div className="flex gap-2">
          <Link href={`/books/${params.bookId}/import`} className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-ink hover:border-accent">
            Import
          </Link>
          <Link href={`/books/${params.bookId}/versions`} className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-ink hover:border-accent">
            Versions
          </Link>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {TOOL_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-faint">{group.title}</p>
            <div className="space-y-2">
              {group.tools.map(([name, status, text]) => (
                <Card key={name}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-display text-base text-ink">{name}</p>
                    <StatusPill status={status} />
                  </div>
                  <p className="mt-2 text-sm leading-6 text-ink-soft">{text}</p>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card>
          <p className="font-display text-lg text-ink">Open live AI tools</p>
          <p className="mt-2 text-sm leading-6 text-ink-soft">Continue and Develop This live inside a chapter workspace.</p>
          <Link
            href={firstChapterId ? `/books/${params.bookId}/chapters/${firstChapterId}` : `/books/${params.bookId}/chapters`}
            className="mt-4 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong"
          >
            Go to writing
          </Link>
        </Card>
        <Card>
          <p className="font-display text-lg text-ink">Open planning</p>
          <p className="mt-2 text-sm leading-6 text-ink-soft">Build My Story and Plan This Chapter live from the Plan workspace.</p>
          <Link href={`/books/${params.bookId}/plan`} className="mt-4 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong">
            Go to Plan
          </Link>
        </Card>
      </div>
    </div>
  );
}
