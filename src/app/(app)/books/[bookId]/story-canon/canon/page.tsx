'use client';

import { useBook } from '@/components/layout/BookContext';
import { StoryBibleTable, type StoryBibleConfig } from '@/components/storybible/StoryBibleTable';

const config: StoryBibleConfig = {
  table: 'canon_facts',
  titleField: 'fact',
  subtitleField: 'canon_status',
  emptyLabel: 'No canon facts yet — these accumulate automatically from Continue and Develop This, or add one by hand.',
  addLabel: 'Add Canon Fact',
  fields: [
    { key: 'fact', label: 'Fact', type: 'textarea' },
    { key: 'fact_type', label: 'Type', type: 'text', hint: 'Free text — e.g. "backstory", "promise", "warning"' },
    {
      key: 'subject_type',
      label: 'Subject',
      type: 'select',
      options: ['character', 'setting', 'relationship', 'story_thread', 'book', 'general']
    },
    { key: 'canon_status', label: 'Status', type: 'select', options: ['working_note', 'author_canon'] }
  ]
};

export default function CanonPage() {
  const { book } = useBook();
  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <p className="mb-2 font-display text-2xl text-ink">Canon Facts</p>
      <p className="mb-6 text-sm text-ink-soft">
        Author Canon is what you've settled — Working Note is saved but not yet promoted. This is separate from
        whether a fact has been checked against the manuscript itself, so a fact can be Author Canon and still
        unconfirmed in the prose, or vice versa. Nothing here is ever written automatically by the AI without you
        approving it first — AI-extracted guesses stay in the Story Canon proposal queue until you review them.
      </p>
      <StoryBibleTable bookId={book.id} config={config} />
    </div>
  );
}
