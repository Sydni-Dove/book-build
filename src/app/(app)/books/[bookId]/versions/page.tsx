import { createServerSupabase } from '@/lib/supabase/server';
import { Card, StatusPill } from '@/components/ui';

export default async function VersionsPage({ params }: { params: { bookId: string } }) {
  const supabase = createServerSupabase();
  const [{ data: chapters }, { data: sections }] = await Promise.all([
    supabase.from('chapters').select('id, title, chapter_number').eq('book_id', params.bookId).is('archived_at', null).order('sort_order', { ascending: true }),
    supabase
      .from('writing_sections')
      .select('word_count, chapter_id')
      .in(
        'chapter_id',
        (await supabase.from('chapters').select('id').eq('book_id', params.bookId).is('archived_at', null)).data?.map((chapter) => chapter.id) ?? []
      )
  ]);

  const wordCount = sections?.reduce((sum, section) => sum + section.word_count, 0) ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Version History</p>
        <h1 className="mt-1 font-display text-2xl text-ink">Current Draft</h1>
      </div>

      <Card className="mb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-display text-lg text-ink">Live manuscript</p>
            <p className="mt-1 text-sm text-ink-soft">
              {chapters?.length ?? 0} chapters, {wordCount} words
            </p>
          </div>
          <StatusPill status="Current" />
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Save Version', 'Manual named snapshots are designed but the version-history migration is still staged.'],
          ['Compare', 'The comparison screen is in the approved prototype and will activate after snapshots exist.'],
          ['Restore', 'Restore will be non-destructive: save the current draft first, then restore the selected snapshot.']
        ].map(([title, text]) => (
          <Card key={title}>
            <p className="font-display text-base text-ink">{title}</p>
            <p className="mt-2 text-sm leading-6 text-ink-soft">{text}</p>
          </Card>
        ))}
      </div>

      <div className="mt-8">
        <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-faint">Manuscript Structure</p>
        <div className="space-y-2">
          {chapters?.map((chapter) => (
            <Card key={chapter.id}>
              <p className="truncate text-sm font-medium text-ink">
                {chapter.chapter_number ? `${chapter.chapter_number}. ` : ''}
                {chapter.title}
              </p>
            </Card>
          ))}
          {chapters?.length === 0 && (
            <Card>
              <p className="text-sm text-ink-soft">No chapters yet.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
