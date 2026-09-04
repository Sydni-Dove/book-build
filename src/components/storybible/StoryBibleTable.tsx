'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button, Card, Field, Input, Textarea } from '@/components/ui';

export interface StoryBibleField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'list';
  options?: string[]; // for select
  hint?: string;
}

// The tables this generic, config-driven editor is actually used for. Kept
// as a literal union (rather than plain `string`) so `.from(config.table)`
// still catches a typo'd table name — Supabase's own generics validate this
// union against the real schema in database.ts.
export type StoryBibleTableName =
  | 'characters'
  | 'settings'
  | 'relationships'
  | 'story_threads'
  | 'canon_facts'
  | 'timeline_events';

export interface StoryBibleConfig {
  table: StoryBibleTableName;
  titleField: string;
  subtitleField?: string;
  fields: StoryBibleField[];
  emptyLabel: string;
  addLabel: string;
}

type Row = Record<string, unknown> & { id: string };

function toFormValue(row: Row | null, field: StoryBibleField) {
  const v = row?.[field.key];
  if (field.type === 'list') return Array.isArray(v) ? (v as string[]).join(', ') : '';
  return typeof v === 'string' ? v : '';
}

function toDbValue(field: StoryBibleField, raw: string) {
  if (field.type === 'list') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw || null;
}

export function StoryBibleTable({ bookId, config }: { bookId: string; config: StoryBibleConfig }) {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function load() {
    const { data } = await supabase
      .from(config.table)
      .select('*')
      .eq('book_id', bookId)
      .order('created_at', { ascending: false });
    setRows((data as Row[]) ?? []);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.table]);

  function openEdit(row: Row | null) {
    const initial: Record<string, string> = {};
    config.fields.forEach((f) => (initial[f.key] = toFormValue(row, f)));
    setForm(initial);
    setEditingId(row ? row.id : 'new');
  }

  async function save() {
    setSaving(true);
    const payload: Record<string, unknown> = { book_id: bookId };
    config.fields.forEach((f) => (payload[f.key] = toDbValue(f, form[f.key] ?? '')));

    // This form is built at runtime from `config.fields`, so `payload`'s exact
    // shape can't be known statically — it's a different Insert/Update type
    // per table. Correctness here is the config author's responsibility (all
    // five configs live in this repo, next to their table's real columns),
    // not the compiler's; the cast is scoped to these two calls only.
    if (editingId === 'new') {
      await supabase.from(config.table).insert(payload as never);
    } else if (editingId) {
      await supabase.from(config.table).update(payload as never).eq('id', editingId);
    }
    setSaving(false);
    setEditingId(null);
    load();
  }

  async function remove(id: string) {
    await supabase.from(config.table).delete().eq('id', id);
    load();
  }

  if (rows === null) return <p className="text-sm text-ink-faint">Loading…</p>;

  if (editingId) {
    return (
      <Card className="max-w-xl">
        <p className="mb-4 font-display text-lg text-ink">
          {editingId === 'new' ? config.addLabel : `Edit ${String((rows.find((r) => r.id === editingId) as Row)?.[config.titleField] ?? '')}`}
        </p>
        <div className="space-y-4">
          {config.fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.type === 'textarea' ? (
                <Textarea rows={3} value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
              ) : f.type === 'select' ? (
                <select
                  value={form[f.key] ?? ''}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  className="w-full rounded-lg border border-line bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                >
                  <option value="">—</option>
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <Input value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
              )}
            </Field>
          ))}
        </div>
        <div className="mt-5 flex gap-2">
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" onClick={() => setEditingId(null)}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Button onClick={() => openEdit(null)}>+ {config.addLabel}</Button>
      {rows.length === 0 && <p className="text-sm text-ink-faint">{config.emptyLabel}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <Card key={r.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{String(r[config.titleField] ?? 'Untitled')}</p>
                {config.subtitleField && r[config.subtitleField] ? (
                  <p className="mt-0.5 line-clamp-2 text-sm text-ink-soft">{String(r[config.subtitleField])}</p>
                ) : null}
              </div>
            </div>
            <div className="mt-3 flex gap-3 text-xs">
              <button onClick={() => openEdit(r)} className="text-accent-strong hover:underline">
                Edit
              </button>
              <button onClick={() => remove(r.id)} className="text-critical hover:underline">
                Delete
              </button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
