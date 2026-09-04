'use client';

import { useBook } from '@/components/layout/BookContext';
import { StoryBibleTable, type StoryBibleConfig } from '@/components/storybible/StoryBibleTable';

const config: StoryBibleConfig = {
  table: 'story_threads',
  titleField: 'title',
  subtitleField: 'status',
  emptyLabel: 'No story threads yet.',
  addLabel: 'Add Story Thread',
  fields: [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Dormant', 'Resolved', 'Planned Later'] },
    { key: 'planned_payoff', label: 'Planned payoff', type: 'textarea', hint: 'Leave blank if you don’t know yet — never guessed by the AI.' },
    { key: 'author_notes', label: 'Author notes', type: 'textarea' }
  ]
};

export default function StoryThreadsPage() {
  const { book } = useBook();
  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <p className="mb-6 font-display text-2xl text-ink">Story Threads</p>
      <StoryBibleTable bookId={book.id} config={config} />
    </div>
  );
}
