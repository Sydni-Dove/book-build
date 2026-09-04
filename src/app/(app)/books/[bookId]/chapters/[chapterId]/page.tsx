'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useBook } from '@/components/layout/BookContext';
import { AIPanel } from '@/components/layout/AIPanel';
import { ChapterReader } from '@/components/editor/ChapterReader';
import { SectionEditor } from '@/components/editor/SectionEditor';
import { HelpMeContinuePanel } from '@/components/ai/HelpMeContinuePanel';
import { DevelopThisPanel } from '@/components/ai/DevelopThisPanel';
import { SectionVersionUpload } from '@/components/versions/SectionVersionUpload';
import { SectionVersionHistory } from '@/components/versions/SectionVersionHistory';
import { ChapterVersionUpload } from '@/components/versions/ChapterVersionUpload';
import { ChapterVersionHistory } from '@/components/versions/ChapterVersionHistory';
import { ExportMenu } from '@/components/export/ExportMenu';
import { Button, Input } from '@/components/ui';
import type { Chapter, WritingSection } from '@/lib/types/database';

const TABS = [
  { id: 'continue', label: 'Continue' },
  { id: 'develop', label: 'Develop This' },
  { id: 'describe', label: 'Describe This' },
  { id: 'review', label: 'Review' },
  { id: 'continuity', label: 'Continuity' }
];

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="space-y-2">
      <p className="font-display text-base text-ink">{label}</p>
      <p className="text-sm text-ink-soft">
        Designed and scheduled for the next build phase, once the core writing loop and Story Canon are stable. Its
        prompt module already exists in <code className="font-mono text-xs">lib/ai/prompts</code> — this is a UI stub.
      </p>
    </div>
  );
}

export default function ChapterWorkspacePage() {
  const { book, aiSheetOpen, setAiSheetOpen } = useBook();
  const params = useParams<{ chapterId: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [sections, setSections] = useState<WritingSection[] | null>(null);
  const [activeTab, setActiveTab] = useState('continue');
  const [addingSection, setAddingSection] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Resizable AI (Development) panel — drag the divider to adjust, click it (or
  // the ↔ button) to expand/restore. Width persists across sessions.
  const AI_DEFAULT_WIDTH = 460;
  const [aiWidth, setAiWidth] = useState(AI_DEFAULT_WIDTH);
  const rowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startW: number; moved: boolean } | null>(null);

  async function load() {
    const [{ data: ch }, { data: secs }] = await Promise.all([
      supabase.from('chapters').select('*').eq('id', params.chapterId).single(),
      supabase.from('writing_sections').select('*').eq('chapter_id', params.chapterId).order('sort_order', { ascending: true })
    ]);
    // Guard: an inactive (removed-from-manuscript) chapter must not open as a
    // live workspace — route back to the active manuscript.
    if (ch?.archived_at) { router.replace(`/books/${book.id}/chapters`); return; }
    setChapter(ch);
    setTitleDraft(ch?.title ?? '');
    setSections(secs ?? []);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.chapterId]);

  // Restore the saved panel width once on mount (client-only, so no SSR mismatch).
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem('bb:aiPanelWidth'));
      if (Number.isFinite(saved) && saved >= 320) setAiWidth(saved);
    } catch { /* private mode / disabled storage — keep default */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem('bb:aiPanelWidth', String(Math.round(aiWidth))); } catch { /* ignore */ }
  }, [aiWidth]);

  async function saveTitle() {
    if (!chapter || titleDraft === chapter.title) return;
    await supabase.from('chapters').update({ title: titleDraft }).eq('id', chapter.id);
  }

  async function addSection() {
    setAddingSection(true);
    const nextOrder = (sections?.[sections.length - 1]?.sort_order ?? -1) + 1;
    const { data } = await supabase
      .from('writing_sections')
      .insert({ chapter_id: params.chapterId, sort_order: nextOrder, content: '' })
      .select()
      .single();
    setAddingSection(false);
    if (data) setSections((s) => [...(s ?? []), data]);
  }

  // Keep the panel between a readable minimum and leaving the manuscript ≥ 380px.
  function clampAiWidth(w: number) {
    const row = rowRef.current?.getBoundingClientRect();
    const max = row ? Math.max(360, row.width - 380) : 1100;
    return Math.min(Math.max(w, 360), max);
  }
  function onHandleDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: aiWidth, moved: false };
  }
  function onHandleMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 3) d.moved = true;
    setAiWidth(clampAiWidth(d.startW - dx)); // dragging left widens the panel
  }
  function onHandleUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d && !d.moved) toggleAiExpand(); // a click (not a drag) toggles expand/restore
  }
  function toggleAiExpand() {
    const row = rowRef.current?.getBoundingClientRect();
    const large = clampAiWidth(row ? Math.round(row.width * 0.6) : 760);
    setAiWidth((w) => (w >= large - 16 ? AI_DEFAULT_WIDTH : large));
  }

  if (!chapter || sections === null) {
    return <div className="px-5 py-8 text-sm text-ink-faint">Loading…</div>;
  }

  const priorSections = sections.slice(0, -1);
  const currentSection = sections[sections.length - 1];
  const totalWords = sections.reduce((sum, s) => sum + s.word_count, 0);

  return (
    <div ref={rowRef} className="flex min-w-0 flex-1">
      <main className="min-w-0 flex-1">
        {/* Persistent chapter header — stays in view while long prose scrolls,
            so the writer always keeps chapter context + save status. */}
        <div className="sticky top-0 z-10 border-b border-line bg-paper/85 backdrop-blur">
          <div className="flex w-full flex-col gap-3 px-5 py-3 sm:px-7 md:flex-row md:items-center md:justify-between lg:px-8">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                {chapter.chapter_number ? `Chapter ${chapter.chapter_number}` : 'Chapter'} · {totalWords} words
              </p>
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                className="w-full truncate border-none bg-transparent font-display text-xl text-ink outline-none"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ChapterVersionUpload
                bookId={book.id}
                chapterId={chapter.id}
                chapterNumber={chapter.chapter_number}
                onApplied={() => { load(); setRefreshKey((k) => k + 1); }}
              />
              <ChapterVersionHistory
                bookId={book.id}
                chapterId={chapter.id}
                chapterNumber={chapter.chapter_number}
                onRestored={() => { load(); setRefreshKey((k) => k + 1); }}
              />
              <ExportMenu
                bookId={book.id}
                bookTitle={book.title}
                chapterId={chapter.id}
                chapterNumber={chapter.chapter_number}
                chapterTitle={chapter.title}
                sectionId={currentSection?.id}
              />
              <Link
                href={`/books/${book.id}/plan/chapter/${chapter.id}`}
                className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-accent-strong transition hover:border-accent"
              >
                Plan this chapter →
              </Link>
            </div>
          </div>
        </div>

        {/* Writing surface — comfortable long-form measure (~768px at 19px),
            wide enough to work, narrow enough to read; generous side padding
            keeps it from floating as a thin strip. */}
        <div className="w-full px-5 py-9 sm:px-7 lg:px-8">
          {priorSections.length > 0 && (
            <div className="mb-8">
              <ChapterReader sections={priorSections} />
            </div>
          )}

          {currentSection ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Current section</p>
                <div className="flex items-center gap-1">
                  <SectionVersionUpload
                    bookId={book.id}
                    chapterId={chapter.id}
                    sectionId={currentSection.id}
                    onApplied={() => { load(); setRefreshKey((k) => k + 1); }}
                  />
                  <span className="text-ink-faint" aria-hidden>·</span>
                  <SectionVersionHistory
                    bookId={book.id}
                    chapterId={chapter.id}
                    sectionId={currentSection.id}
                    onRestored={() => { load(); setRefreshKey((k) => k + 1); }}
                  />
                </div>
              </div>
              <SectionEditor key={`${currentSection.id}:${refreshKey}`} section={currentSection} />
            </>
          ) : (
            <p className="text-sm text-ink-faint">This chapter is empty — start the first section below.</p>
          )}

          <div className="mt-8 border-t border-line pt-6">
            <Button variant="secondary" onClick={addSection} disabled={addingSection}>
              {addingSection ? 'Adding…' : '+ New Section'}
            </Button>
            <p className="mt-2 text-xs text-ink-faint">
              Starts a fresh writing unit under this chapter — the previous one stays visible above, read-only.
            </p>
          </div>
        </div>
      </main>

      {/* Desktop drag divider: drag to resize the panel, click to expand/restore. */}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onDoubleClick={() => setAiWidth(AI_DEFAULT_WIDTH)}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · click to expand or restore · double-click to reset"
        className="relative hidden w-1.5 shrink-0 cursor-col-resize touch-none select-none self-stretch bg-line/50 transition hover:bg-accent/60 lg:block"
      />

      <AIPanel
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        openOnMobile={aiSheetOpen}
        onCloseMobile={() => setAiSheetOpen(false)}
        desktopStyle={{ width: aiWidth }}
        onToggleExpand={toggleAiExpand}
      >
        {activeTab === 'continue' && (
          <HelpMeContinuePanel bookId={book.id} chapterId={chapter.id} sectionId={currentSection?.id} />
        )}
        {activeTab === 'develop' && (
          <DevelopThisPanel bookId={book.id} chapterId={chapter.id} sectionId={currentSection?.id} />
        )}
        {activeTab === 'describe' && <ComingSoon label="Describe This" />}
        {activeTab === 'review' && <ComingSoon label="Review Section" />}
        {activeTab === 'continuity' && <ComingSoon label="Continuity Check" />}
      </AIPanel>
    </div>
  );
}
