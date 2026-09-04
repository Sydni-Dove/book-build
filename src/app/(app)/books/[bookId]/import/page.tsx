import { createServerSupabase } from '@/lib/supabase/server';
import { Card, StatusPill } from '@/components/ui';

export default async function ImportPage({ params }: { params: { bookId: string } }) {
  const supabase = createServerSupabase();
  const { data: imports, error } = await supabase
    .from('manuscript_imports')
    .select('*')
    .eq('book_id', params.bookId)
    .order('created_at', { ascending: false });

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Manuscript Import</p>
        <h1 className="mt-1 font-display text-2xl text-ink">Bring in an existing manuscript.</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-[1.15fr_0.85fr]">
        <Card>
          <div className="rounded-lg border border-dashed border-line bg-paper px-4 py-8 text-center">
            <p className="font-display text-lg text-ink">DOCX import</p>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-soft">
              The import tables are in the schema. The file parser and chapter review step still need the next implementation pass.
            </p>
            <button
              type="button"
              disabled
              className="mt-5 inline-flex items-center justify-center rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-ink-faint"
            >
              Select .docx
            </button>
          </div>
        </Card>

        <Card>
          <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Flow</p>
          <ol className="mt-3 space-y-3 text-sm text-ink-soft">
            <li className="flex gap-3"><span className="font-bold text-accent-strong">1</span><span>Upload the manuscript file.</span></li>
            <li className="flex gap-3"><span className="font-bold text-accent-strong">2</span><span>Review detected chapter breaks.</span></li>
            <li className="flex gap-3"><span className="font-bold text-accent-strong">3</span><span>Create chapters and sections.</span></li>
            <li className="flex gap-3"><span className="font-bold text-accent-strong">4</span><span>Review proposed Story Canon items.</span></li>
          </ol>
        </Card>
      </div>

      <div className="mt-8">
        <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-faint">Import History</p>
        {error && (
          <Card>
            <p className="text-sm text-critical">Import history is not available from the current database.</p>
          </Card>
        )}
        {!error && imports?.length === 0 && (
          <Card>
            <p className="text-sm text-ink-soft">No manuscripts have been imported for this book yet.</p>
          </Card>
        )}
        <div className="space-y-2">
          {imports?.map((item) => (
            <Card key={item.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{item.original_filename}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{new Date(item.created_at).toLocaleString()}</p>
              </div>
              <StatusPill status={item.processing_state} />
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
