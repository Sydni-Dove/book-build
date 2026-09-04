'use client';

import { useBook } from '@/components/layout/BookContext';
import { StoryBibleTable, type StoryBibleConfig } from '@/components/storybible/StoryBibleTable';

const config: StoryBibleConfig = {
  table: 'settings',
  titleField: 'name',
  subtitleField: 'setting_type',
  emptyLabel: 'No settings yet — build a profile for a place you’ll return to.',
  addLabel: 'Add Setting',
  fields: [
    { key: 'name', label: 'Name', type: 'text', hint: 'e.g. "Daniella’s Bedroom"' },
    { key: 'setting_type', label: 'Type', type: 'text', hint: 'Bedroom, church, diner, forest…' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'layout', label: 'Layout', type: 'textarea', hint: 'What’s near, what’s far — this is what continuity checks compare against.' },
    { key: 'lighting', label: 'Lighting', type: 'text' },
    { key: 'sounds', label: 'Sounds', type: 'text' },
    { key: 'smells', label: 'Smells', type: 'text' },
    { key: 'sensory_details', label: 'Other sensory details', type: 'textarea' },
    { key: 'atmosphere', label: 'Emotional atmosphere', type: 'text' },
    { key: 'important_objects', label: 'Important objects', type: 'textarea' },
    { key: 'canon_notes', label: 'Canon notes', type: 'textarea' }
  ]
};

export default function LocationsPage() {
  const { book } = useBook();
  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <p className="mb-6 font-display text-2xl text-ink">Settings</p>
      <StoryBibleTable bookId={book.id} config={config} />
    </div>
  );
}
