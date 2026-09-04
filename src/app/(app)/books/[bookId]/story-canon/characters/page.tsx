'use client';

import { useBook } from '@/components/layout/BookContext';
import { StoryBibleTable, type StoryBibleConfig } from '@/components/storybible/StoryBibleTable';

const config: StoryBibleConfig = {
  table: 'characters',
  titleField: 'name',
  subtitleField: 'role',
  emptyLabel: 'No characters yet — add the people who matter to this story.',
  addLabel: 'Add Character',
  fields: [
    { key: 'name', label: 'Full name', type: 'text' },
    { key: 'role', label: 'Role', type: 'text', hint: 'Protagonist, love interest, mentor…' },
    { key: 'age', label: 'Age', type: 'text' },
    { key: 'appearance', label: 'Appearance', type: 'textarea' },
    { key: 'personality', label: 'Personality', type: 'textarea' },
    { key: 'background', label: 'Background', type: 'textarea' },
    { key: 'goals', label: 'Goals', type: 'textarea' },
    { key: 'fears', label: 'Fears', type: 'textarea' },
    { key: 'beliefs', label: 'Beliefs', type: 'textarea' },
    { key: 'voice_notes', label: 'Voice notes', type: 'textarea', hint: 'How they speak — feeds dialogue consistency.' },
    { key: 'author_notes', label: 'Author notes', type: 'textarea' }
  ]
};

export default function CharactersPage() {
  const { book } = useBook();
  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <p className="mb-6 font-display text-2xl text-ink">Characters</p>
      <StoryBibleTable bookId={book.id} config={config} />
    </div>
  );
}
