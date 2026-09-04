'use client';

import { useBook } from '@/components/layout/BookContext';
import { StoryBibleTable, type StoryBibleConfig } from '@/components/storybible/StoryBibleTable';

const config: StoryBibleConfig = {
  table: 'timeline_events',
  titleField: 'event_description',
  subtitleField: 'date_text',
  emptyLabel: 'No timeline events yet.',
  addLabel: 'Add Timeline Event',
  fields: [
    { key: 'event_description', label: 'What happened', type: 'textarea' },
    { key: 'date_text', label: 'Date', type: 'text', hint: 'Only if the manuscript states one' },
    { key: 'time_text', label: 'Time', type: 'text' },
    { key: 'relative_time', label: 'Relative timing', type: 'text', hint: '"Three days later", "the following Sunday"…' }
  ]
};

export default function TimelinePage() {
  const { book } = useBook();
  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <p className="mb-6 font-display text-2xl text-ink">Timeline</p>
      <StoryBibleTable bookId={book.id} config={config} />
    </div>
  );
}
