'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useBook } from '@/components/layout/BookContext';
import { Button, Card, Field, Input, Textarea } from '@/components/ui';
import type { BookStatus, SuggestionLevel } from '@/lib/types/database';

const STATUSES: BookStatus[] = ['Planning', 'Drafting', 'Revising', 'Completed'];
const LEVELS: { value: SuggestionLevel; label: string; hint: string }[] = [
  { value: 'light', label: 'Light', hint: 'Grammar and hard continuity contradictions only.' },
  { value: 'guided', label: 'Guided', hint: 'Questions, description help, continuity, and reviews. (Default)' },
  { value: 'deep', label: 'Deep Development', hint: 'Adds motivation, pacing, and setup/payoff probing.' }
];
const TOGGLE_LABELS: { key: keyof ReturnType<typeof defaultToggles>; label: string }[] = [
  { key: 'ask_before_prose', label: 'Ask before suggesting prose' },
  { key: 'continuity_warnings', label: 'Continuity warnings' },
  { key: 'thread_reminders', label: 'Story thread reminders' },
  { key: 'description_reminders', label: 'Description reminders' },
  { key: 'reaction_reminders', label: 'Character reaction reminders' }
];
function defaultToggles() {
  return {
    ask_before_prose: true,
    continuity_warnings: true,
    thread_reminders: true,
    description_reminders: true,
    reaction_reminders: true
  };
}

export default function BookSettingsPage() {
  const { book } = useBook();
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState({
    title: book.title,
    subtitle: book.subtitle ?? '',
    genre: book.genre ?? '',
    target_audience: book.target_audience ?? '',
    pov: book.pov ?? '',
    tense: book.tense ?? '',
    description: book.description ?? '',
    author_notes: book.author_notes ?? '',
    status: book.status,
    ai_suggestion_level: book.ai_suggestion_level,
    writing_unit_pref: book.writing_unit_pref
  });
  const [toggles, setToggles] = useState(book.ai_toggles ?? defaultToggles());
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await supabase
      .from('books')
      .update({ ...form, ai_toggles: toggles })
      .eq('id', book.id);
    setSaving(false);
    router.refresh();
  }

  async function deleteBook() {
    if (!confirm(`Delete "${book.title}" and everything in it? This can't be undone.`)) return;
    await supabase.from('books').delete().eq('id', book.id);
    router.push('/dashboard');
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <p className="mb-6 font-display text-2xl text-ink">Book Settings</p>

      <Card className="mb-6 space-y-4">
        <Field label="Title">
          <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        </Field>
        <Field label="Subtitle">
          <Input value={form.subtitle} onChange={(e) => setForm((f) => ({ ...f, subtitle: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Genre">
            <Input value={form.genre} onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))} />
          </Field>
          <Field label="Target audience">
            <Input value={form.target_audience} onChange={(e) => setForm((f) => ({ ...f, target_audience: e.target.value }))} />
          </Field>
          <Field label="POV">
            <Input placeholder="First person, close third…" value={form.pov} onChange={(e) => setForm((f) => ({ ...f, pov: e.target.value }))} />
          </Field>
          <Field label="Tense">
            <Input placeholder="Past, present…" value={form.tense} onChange={(e) => setForm((f) => ({ ...f, tense: e.target.value }))} />
          </Field>
        </div>
        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as BookStatus }))}
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Book description / premise">
          <Textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
        <Field label="Author notes" hint="Anything you want to remember — not shown to readers.">
          <Textarea rows={3} value={form.author_notes} onChange={(e) => setForm((f) => ({ ...f, author_notes: e.target.value }))} />
        </Field>
      </Card>

      <Card className="mb-6 space-y-4">
        <p className="font-display text-lg text-ink">AI Controls</p>
        <Field label="AI Assistance Level">
          <div className="space-y-2">
            {LEVELS.map((l) => (
              <label key={l.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  checked={form.ai_suggestion_level === l.value}
                  onChange={() => setForm((f) => ({ ...f, ai_suggestion_level: l.value }))}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium text-ink">{l.label}</span> — <span className="text-ink-soft">{l.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Preferred writing unit">
          <select
            value={form.writing_unit_pref}
            onChange={(e) => setForm((f) => ({ ...f, writing_unit_pref: e.target.value as typeof form.writing_unit_pref }))}
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          >
            <option value="paragraph">Paragraph</option>
            <option value="page">Page</option>
            <option value="scene_section">Scene Section</option>
            <option value="full_scene">Full Scene</option>
          </select>
        </Field>
        <div className="space-y-2">
          {TOGGLE_LABELS.map((t) => (
            <label key={t.key} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={toggles[t.key]}
                onChange={(e) => setToggles((tg) => ({ ...tg, [t.key]: e.target.checked }))}
              />
              {t.label}
            </label>
          ))}
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </Button>
        <Button variant="danger" onClick={deleteBook}>
          Delete Book
        </Button>
      </div>
    </div>
  );
}
