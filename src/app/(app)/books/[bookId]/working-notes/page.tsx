'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { DevelopThisPanel } from '@/components/ai/DevelopThisPanel';
import { useBook } from '@/components/layout/BookContext';
import { Button, Card, Input } from '@/components/ui';
import { useWorkingNoteAutosave } from '@/hooks/useAutosave';
import type { WorkingNote, WorkingNoteType, WritingSection } from '@/lib/types/database';

type Filter = 'all' | 'ideas' | 'notes' | 'drafts';
type SectionOption = Pick<WritingSection, 'id' | 'chapter_id' | 'title' | 'sort_order'>;

const TYPE_LABEL: Record<WorkingNoteType, string> = {
  thought: 'Thought',
  idea: 'Idea',
  note: 'Note',
  draft: 'Draft'
};

const TYPE_STYLES: Record<WorkingNoteType, string> = {
  thought: 'bg-paper-sunken text-ink-soft',
  idea: 'bg-gold-soft text-gold-strong',
  note: 'bg-confirmed-soft text-ink-soft',
  draft: 'bg-accent-soft text-accent-strong'
};

const FILTERS: { key: Filter; label: string; match: (note: WorkingNote) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'ideas', label: 'Ideas', match: (note) => note.note_type === 'idea' },
  { key: 'notes', label: 'Notes', match: (note) => note.note_type === 'note' || note.note_type === 'thought' },
  { key: 'drafts', label: 'Drafts', match: (note) => note.note_type === 'draft' }
];

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function preview(content: string) {
  const trimmed = content.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 180) : 'No words yet.';
}

function safeFileName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'working-note';
}

function noteSeed(note: WorkingNote) {
  return [
    'WORKING / NON-CANONICAL MATERIAL',
    'This is a private Working Note. It is not manuscript prose, not Story Canon, and not an established story fact.',
    '',
    `Type: ${TYPE_LABEL[note.note_type]}`,
    `Title: ${note.title || 'Untitled note'}`,
    note.content.trim() ? `Content:\n${note.content.trim()}` : 'Content: empty'
  ].join('\n');
}

function WorkingNoteEditor({
  note,
  chapters,
  sections,
  sectionById,
  onLocalPatch,
  onPatch,
  onArchive
}: {
  note: WorkingNote;
  chapters: ReturnType<typeof useBook>['chapters'];
  sections: SectionOption[];
  sectionById: Map<string, SectionOption>;
  onLocalPatch: (id: string, patch: Partial<WorkingNote>) => void;
  onPatch: (id: string, patch: Partial<WorkingNote>) => Promise<void>;
  onArchive: (note: WorkingNote) => Promise<void>;
}) {
  const [titleDraft, setTitleDraft] = useState(note.title);
  const [showDevelop, setShowDevelop] = useState(false);
  const { content, setContent, status, wordCount } = useWorkingNoteAutosave(note.id, note.content, (saved) => {
    onLocalPatch(note.id, { content: saved });
  });

  useEffect(() => {
    setTitleDraft(note.title);
    setShowDevelop(false);
  }, [note.id, note.title]);

  const availableSections = sections.filter((section) => section.chapter_id === note.chapter_id);
  const aiChapterId = note.chapter_id ?? chapters[0]?.id ?? null;
  const selectedChapter = chapters.find((chapter) => chapter.id === note.chapter_id);
  const selectedSection = note.section_id ? sectionById.get(note.section_id) : null;

  async function saveTitle() {
    const title = titleDraft.trim() || 'Untitled note';
    setTitleDraft(title);
    if (title !== note.title) await onPatch(note.id, { title });
  }

  async function copyText() {
    await navigator.clipboard.writeText(content);
  }

  function downloadText() {
    const body = [`# ${titleDraft.trim() || 'Untitled note'}`, '', `Type: ${TYPE_LABEL[note.note_type]}`, 'Boundary: Working / non-canonical material', '', content].join('\n');
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFileName(titleDraft)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={`grid min-h-[70vh] gap-5 ${showDevelop ? 'xl:grid-cols-[minmax(0,0.95fr)_minmax(24rem,1.05fr)]' : ''}`}>
      <Card className="flex min-w-0 flex-col p-0">
        <div className="border-b border-line px-5 py-4 sm:px-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${TYPE_STYLES[note.note_type]}`}>
              {TYPE_LABEL[note.note_type]}
            </span>
            <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
              Working / non-canonical
            </span>
            {note.status === 'archived' && (
              <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                Archived
              </span>
            )}
          </div>

          <Input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={saveTitle}
            className="border-none bg-transparent px-0 font-display text-2xl shadow-none focus:border-transparent focus:ring-0"
            aria-label="Working note title"
          />

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-faint">Type</span>
              <select
                value={note.note_type}
                onChange={(event) => onPatch(note.id, { note_type: event.target.value as WorkingNoteType })}
                className="min-h-11 w-full rounded-lg border border-line bg-white px-3 text-base text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="thought">Thought</option>
                <option value="idea">Idea</option>
                <option value="note">Note</option>
                <option value="draft">Draft</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-faint">Linked chapter</span>
              <select
                value={note.chapter_id ?? ''}
                onChange={(event) => onPatch(note.id, { chapter_id: event.target.value || null, section_id: null })}
                className="min-h-11 w-full rounded-lg border border-line bg-white px-3 text-base text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="">Book-level note</option>
                {chapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.chapter_number ? `Chapter ${chapter.chapter_number}: ` : ''}
                    {chapter.title || 'Untitled chapter'}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-faint">Linked section</span>
              <select
                value={note.section_id ?? ''}
                onChange={(event) => onPatch(note.id, { section_id: event.target.value || null })}
                disabled={!note.chapter_id}
                className="min-h-11 w-full rounded-lg border border-line bg-white px-3 text-base text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:bg-paper-sunken disabled:text-ink-faint"
              >
                <option value="">No section link</option>
                {availableSections.map((section) => (
                  <option key={section.id} value={section.id}>
                    Section {section.sort_order + 1}
                    {section.title ? `: ${section.title}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-faint">
            <span>Updated {formatDate(note.updated_at)}</span>
            {selectedChapter && <span>Linked to {selectedChapter.chapter_number ? `Chapter ${selectedChapter.chapter_number}` : selectedChapter.title}</span>}
            {selectedSection && <span>Section {selectedSection.sort_order + 1}</span>}
          </div>
        </div>

        <div className="flex flex-1 flex-col px-5 py-5 sm:px-6">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Write loose thoughts, possible scenes, dialogue fragments, reminders, or experimental prose..."
            className="min-h-[56vh] w-full flex-1 resize-y rounded-xl border border-line bg-paper px-4 py-4 text-base leading-7 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <div className="flex flex-wrap gap-3 text-xs text-ink-faint">
              <span>{wordCount} words</span>
              <span>{status === 'saving' ? 'Saving...' : status === 'saved' ? 'Saved' : status === 'error' ? "Couldn't save - retrying..." : 'Ready'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={copyText} className="min-h-11">
                Copy text
              </Button>
              <Button type="button" variant="secondary" onClick={downloadText} className="min-h-11">
                Download
              </Button>
              <Button type="button" variant="secondary" onClick={() => setShowDevelop((open) => !open)} disabled={!aiChapterId} className="min-h-11">
                Develop with AI
              </Button>
              <Button type="button" variant="ghost" onClick={() => onArchive(note)} className="min-h-11">
                {note.status === 'archived' ? 'Restore' : 'Archive'}
              </Button>
            </div>
          </div>

          {!aiChapterId && (
            <p className="mt-2 text-sm text-ink-faint">Add a manuscript chapter before using the existing development interview with this note.</p>
          )}
        </div>
      </Card>

      {showDevelop && aiChapterId && (
        <Card className="min-w-0">
          <p className="mb-1 font-display text-lg text-ink">Develop This Note</p>
          <p className="mb-4 text-sm leading-6 text-ink-soft">
            The interview receives this as working material only. It will not rewrite the manuscript or add anything to Story Canon.
          </p>
          <DevelopThisPanel
            key={note.id}
            bookId={note.book_id}
            chapterId={aiChapterId}
            sectionId={note.section_id ?? undefined}
            workingNoteId={note.id}
            initialSeedIdea={noteSeed({ ...note, content })}
          />
        </Card>
      )}
    </div>
  );
}

export default function WorkingNotesPage() {
  const { book, chapters } = useBook();
  const supabase = useMemo(() => createClient(), []);
  const [notes, setNotes] = useState<WorkingNote[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const notesQuery = supabase
      .from('working_notes')
      .select('*')
      .eq('book_id', book.id)
      .order('updated_at', { ascending: false });

    const chapterIds = chapters.map((chapter) => chapter.id);
    const sectionsQuery = chapterIds.length
      ? supabase
          .from('writing_sections')
          .select('id, chapter_id, title, sort_order')
          .in('chapter_id', chapterIds)
          .order('sort_order', { ascending: true })
      : Promise.resolve({ data: [] as SectionOption[], error: null });

    const [{ data: noteRows, error: notesError }, { data: sectionRows }] = await Promise.all([notesQuery, sectionsQuery]);

    if (notesError) {
      setError('Working Notes could not load. Make sure the working_notes migration has been applied.');
      setNotes([]);
    } else {
      const nextNotes = noteRows ?? [];
      setNotes(nextNotes);
      setSelectedId((current) => current && nextNotes.some((note) => note.id === current) ? current : nextNotes[0]?.id ?? null);
    }
    setSections(sectionRows ?? []);
    setLoading(false);
  }, [book.id, chapters, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function createNote(noteType: WorkingNoteType = 'note') {
    setCreating(true);
    setError(null);
    const { data, error: createError } = await supabase
      .from('working_notes')
      .insert({
        book_id: book.id,
        title: noteType === 'draft' ? 'Untitled draft' : noteType === 'idea' ? 'Untitled idea' : noteType === 'thought' ? 'Untitled thought' : 'Untitled note',
        note_type: noteType
      })
      .select()
      .single();
    setCreating(false);
    if (createError || !data) {
      setError('Could not create that note.');
      return;
    }
    setNotes((current) => [data, ...current]);
    setSelectedId(data.id);
    setFilter(noteType === 'idea' ? 'ideas' : noteType === 'draft' ? 'drafts' : 'notes');
  }

  async function patchNote(id: string, patch: Partial<WorkingNote>) {
    setNotes((current) => current.map((note) => (note.id === id ? { ...note, ...patch } : note)));
    const { data, error: updateError } = await supabase
      .from('working_notes')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (updateError || !data) {
      setError('Could not save that note change.');
      await load();
      return;
    }
    setNotes((current) => current.map((note) => (note.id === id ? data : note)));
  }

  async function archiveNote(note: WorkingNote) {
    if (note.status === 'archived') {
      await patchNote(note.id, { status: 'active' });
      return;
    }
    const confirmed = window.confirm('Archive this working note? It will leave the active list, but it will not be deleted.');
    if (!confirmed) return;
    await patchNote(note.id, { status: 'archived' });
  }

  function patchLocalNote(id: string, patch: Partial<WorkingNote>) {
    setNotes((current) => current.map((note) => (note.id === id ? { ...note, ...patch } : note)));
  }

  const activeFilter = FILTERS.find((item) => item.key === filter) ?? FILTERS[0]!;
  const visibleNotes = notes.filter((note) => (showArchived || note.status === 'active') && activeFilter.match(note));
  const selectedNote = notes.find((note) => note.id === selectedId) ?? visibleNotes[0] ?? null;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-8 sm:px-7 lg:px-10 xl:px-12">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-display text-2xl text-ink">Working Notes</p>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-soft">
            A place for ideas, rough drafts, questions, and possibilities that aren't part of your manuscript yet.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => createNote()} disabled={creating} className="min-h-11">
            {creating ? 'Creating...' : '+ New Note'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => createNote('idea')} disabled={creating} className="min-h-11">
            Idea
          </Button>
          <Button type="button" variant="secondary" onClick={() => createNote('draft')} disabled={creating} className="min-h-11">
            Draft
          </Button>
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              onClick={() => setFilter(item.key)}
              className={`min-h-[40px] rounded-lg px-3 text-xs font-medium transition ${
                filter === item.key ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-black/5'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="flex min-h-[40px] items-center gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="h-4 w-4 rounded border-line-strong"
          />
          Show archived
        </label>
      </div>

      {loading && <p className="py-10 text-center text-sm text-ink-faint">Loading working notes...</p>}

      {!loading && notes.length === 0 && (
        <div className="rounded-xl border border-line bg-paper px-4 py-12 text-center">
          <p className="font-display text-lg text-ink">Start a private notebook for this book.</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-soft">
            Capture loose ideas, alternate scenes, questions, and possible drafts here before they belong anywhere else.
          </p>
          <Button type="button" onClick={() => createNote()} disabled={creating} className="mt-5 min-h-11">
            + New Note
          </Button>
        </div>
      )}

      {!loading && notes.length > 0 && (
        <div className="grid gap-5 xl:grid-cols-[minmax(18rem,0.38fr)_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-2">
            {visibleNotes.length === 0 && (
              <Card>
                <p className="text-sm text-ink-soft">Nothing in this view.</p>
              </Card>
            )}

            {visibleNotes.map((note) => {
              const chapter = chapters.find((item) => item.id === note.chapter_id);
              const section = note.section_id ? sectionById.get(note.section_id) : null;
              return (
                <button
                  key={note.id}
                  onClick={() => setSelectedId(note.id)}
                  className={`w-full rounded-xl border bg-surface p-4 text-left transition ${
                    selectedNote?.id === note.id ? 'border-accent shadow-sm' : 'border-line hover:border-accent/60'
                  } ${note.status === 'archived' ? 'opacity-70' : ''}`}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TYPE_STYLES[note.note_type]}`}>
                      {TYPE_LABEL[note.note_type]}
                    </span>
                    <span className="text-[11px] text-ink-faint">{formatDate(note.updated_at)}</span>
                  </div>
                  <p className="line-clamp-1 font-display text-base text-ink">{note.title || 'Untitled note'}</p>
                  <p className="mt-1 line-clamp-2 text-sm leading-5 text-ink-soft">{preview(note.content)}</p>
                  {(chapter || section) && (
                    <p className="mt-2 line-clamp-1 text-xs text-ink-faint">
                      {chapter ? `${chapter.chapter_number ? `Chapter ${chapter.chapter_number}` : chapter.title}` : 'Book-level'}
                      {section ? ` / Section ${section.sort_order + 1}` : ''}
                    </p>
                  )}
                </button>
              );
            })}
          </aside>

          <section className="min-w-0">
            {selectedNote ? (
              <WorkingNoteEditor
                key={selectedNote.id}
                note={selectedNote}
                chapters={chapters}
                sections={sections}
                sectionById={sectionById}
                onLocalPatch={patchLocalNote}
                onPatch={patchNote}
                onArchive={archiveNote}
              />
            ) : (
              <Card>
                <p className="text-sm text-ink-soft">Choose a working note, or create a new one.</p>
              </Card>
            )}

            {selectedNote?.chapter_id && (
              <div className="mt-3 flex flex-wrap gap-2 text-sm">
                <Link href={`/books/${book.id}/chapters/${selectedNote.chapter_id}`} className="font-medium text-accent-strong hover:underline">
                  Open linked manuscript chapter
                </Link>
                <span className="text-ink-faint">Copy text first; nothing is inserted automatically.</span>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
