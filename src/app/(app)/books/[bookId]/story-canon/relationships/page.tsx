'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useBook } from '@/components/layout/BookContext';
import { Button, Card, Field, Input, Textarea } from '@/components/ui';
import type { Character, Relationship } from '@/lib/types/database';

const emptyForm = {
  character_a_id: '',
  character_b_id: '',
  relationship_type: '',
  current_status: '',
  history: '',
  unresolved_tension: '',
  notes: ''
};

export default function RelationshipsPage() {
  const { book } = useBook();
  const supabase = createClient();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [relationships, setRelationships] = useState<Relationship[] | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  async function load() {
    const [{ data: chars }, { data: rels }] = await Promise.all([
      supabase.from('characters').select('*').eq('book_id', book.id).order('name'),
      supabase.from('relationships').select('*').eq('book_id', book.id).order('updated_at', { ascending: false })
    ]);
    setCharacters(chars ?? []);
    setRelationships(rels ?? []);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function nameFor(id: string) {
    return characters.find((c) => c.id === id)?.name ?? '—';
  }

  function openEdit(r: Relationship | null) {
    setForm(
      r
        ? {
            character_a_id: r.character_a_id,
            character_b_id: r.character_b_id,
            relationship_type: r.relationship_type ?? '',
            current_status: r.current_status ?? '',
            history: r.history ?? '',
            unresolved_tension: r.unresolved_tension ?? '',
            notes: r.notes ?? ''
          }
        : emptyForm
    );
    setEditingId(r ? r.id : 'new');
  }

  async function save() {
    if (!form.character_a_id || !form.character_b_id || form.character_a_id === form.character_b_id) return;
    setSaving(true);
    const payload = { ...form, book_id: book.id };
    if (editingId === 'new') {
      await supabase.from('relationships').insert(payload);
    } else if (editingId) {
      await supabase.from('relationships').update(payload).eq('id', editingId);
    }
    setSaving(false);
    setEditingId(null);
    load();
  }

  async function remove(id: string) {
    await supabase.from('relationships').delete().eq('id', id);
    load();
  }

  if (relationships === null) return <div className="px-5 py-8 text-sm text-ink-faint">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <p className="mb-6 font-display text-2xl text-ink">Relationships</p>

      {characters.length < 2 && !editingId && (
        <p className="mb-4 text-sm text-ink-faint">Add at least two characters first — relationships link two of them.</p>
      )}

      {editingId ? (
        <Card className="max-w-xl space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Character A">
              <select value={form.character_a_id} onChange={(e) => setForm((f) => ({ ...f, character_a_id: e.target.value }))} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent">
                <option value="">Select…</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Character B">
              <select value={form.character_b_id} onChange={(e) => setForm((f) => ({ ...f, character_b_id: e.target.value }))} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent">
                <option value="">Select…</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Relationship type">
            <Input placeholder="Friends, siblings, love interest…" value={form.relationship_type} onChange={(e) => setForm((f) => ({ ...f, relationship_type: e.target.value }))} />
          </Field>
          <Field label="Current status">
            <Input value={form.current_status} onChange={(e) => setForm((f) => ({ ...f, current_status: e.target.value }))} />
          </Field>
          <Field label="History">
            <Textarea rows={2} value={form.history} onChange={(e) => setForm((f) => ({ ...f, history: e.target.value }))} />
          </Field>
          <Field label="Unresolved tension">
            <Textarea rows={2} value={form.unresolved_tension} onChange={(e) => setForm((f) => ({ ...f, unresolved_tension: e.target.value }))} />
          </Field>
          <Field label="Notes">
            <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
          <div className="flex gap-2">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : (
        <Button onClick={() => openEdit(null)} disabled={characters.length < 2}>
          + Add Relationship
        </Button>
      )}

      {!editingId && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {relationships.map((r) => (
            <Card key={r.id}>
              <p className="font-medium text-ink">
                {nameFor(r.character_a_id)} ↔ {nameFor(r.character_b_id)}
              </p>
              <p className="mt-0.5 text-sm text-ink-soft">
                {r.relationship_type || 'Type not set'}
                {r.current_status ? ` — ${r.current_status}` : ''}
              </p>
              {r.unresolved_tension && <p className="mt-1 text-xs text-warn">Unresolved: {r.unresolved_tension}</p>}
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
      )}
    </div>
  );
}
