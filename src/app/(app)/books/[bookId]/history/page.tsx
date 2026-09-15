'use client';

/**
 * Activity History — a read-only timeline of the AI work done on this book:
 * Review runs, Develop This / Help Me Continue sessions, and Plan sessions +
 * outline versions. Everything is pulled from existing tables (review_ai_runs,
 * ai_interviews, story_outlines, chapter_outlines), RLS-scoped to the owner —
 * no new storage, nothing here changes the manuscript.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useBook } from '@/components/layout/BookContext';

type Category = 'review' | 'develop' | 'plan';
type HistoryEvent = {
  key: string;
  category: Category;
  title: string;
  detail?: string | null;
  chapterId?: string | null;
  status?: string | null;
  date: string;
  href?: string;
};

const CAT_LABEL: Record<Category, string> = { review: 'Review', develop: 'Develop', plan: 'Plan' };
const CAT_CHIP: Record<Category, string> = {
  review: 'bg-coral-soft text-accent-strong',
  develop: 'bg-accent-soft text-accent-strong',
  plan: 'bg-gold-soft text-gold-strong'
};
const DEV_LABEL: Record<string, string> = { development: 'Develop This', continue: 'Help Me Continue', setting: 'Describe a Setting', character: 'Develop a Character', continuity_fix: 'Continuity Fix' };
const PLAN_LABEL: Record<string, string> = { plan_new_book: 'Book Plan session', plan_chapter: 'Chapter Plan session' };
const STATUS_LABEL: Record<string, string> = { in_progress: 'In progress', complete: 'Complete', abandoned: 'Abandoned' };
const DEV_TYPES = ['development', 'continue', 'setting', 'character', 'continuity_fix'];

function relativeDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const FILTERS: { key: 'all' | Category; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Review' },
  { key: 'develop', label: 'Develop' },
  { key: 'plan', label: 'Plan' }
];

export default function HistoryPage() {
  const { book, chapters } = useBook();
  const supabase = useMemo(() => createClient(), []);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [filter, setFilter] = useState<'all' | Category>('all');
  const [error, setError] = useState<string | null>(null);

  const base = `/books/${book.id}`;
  const chapterById = useMemo(() => new Map(chapters.map((c) => [c.id, c])), [chapters]);
  const chapterLabel = useCallback((id: string | null | undefined) => {
    if (!id) return null;
    const c = chapterById.get(id);
    if (!c) return null;
    return c.chapter_number ? `Chapter ${c.chapter_number}${c.title ? `: ${c.title}` : ''}` : c.title;
  }, [chapterById]);

  const load = useCallback(async () => {
    try {
      const chapterIds = chapters.map((c) => c.id);
      const [runs, interviews, outlines, chOutlines] = await Promise.all([
        supabase.from('review_ai_runs').select('id, scope, source, created_at').eq('book_id', book.id),
        supabase.from('ai_interviews').select('id, interview_type, topic, chapter_id, status, updated_at, created_at').eq('book_id', book.id),
        supabase.from('story_outlines').select('id, structure_type, version_number, is_current, note, created_at').eq('book_id', book.id),
        chapterIds.length
          ? supabase.from('chapter_outlines').select('id, chapter_id, version_number, is_current, purpose, created_at').in('chapter_id', chapterIds)
          : Promise.resolve({ data: [] as unknown[] })
      ]);

      const out: HistoryEvent[] = [];

      for (const r of (runs.data ?? []) as { id: string; scope: string; source: string | null; created_at: string }[]) {
        const chapterScoped = r.scope !== 'book';
        out.push({
          key: `run:${r.id}`, category: 'review',
          title: chapterScoped ? 'Deep review — chapter' : 'Deep review — whole book',
          detail: chapterScoped ? (chapterLabel(r.scope) ?? 'A chapter') : null,
          chapterId: chapterScoped && chapterById.has(r.scope) ? r.scope : null,
          status: r.source === 'mcp_host' ? 'MCP host' : r.source === 'openai' ? 'AI' : r.source,
          date: r.created_at, href: `${base}/review`
        });
      }

      for (const iv of (interviews.data ?? []) as { id: string; interview_type: string; topic: string | null; chapter_id: string | null; status: string; updated_at: string; created_at: string }[]) {
        const isPlan = iv.interview_type === 'plan_new_book' || iv.interview_type === 'plan_chapter';
        const isDev = DEV_TYPES.includes(iv.interview_type);
        if (!isPlan && !isDev) continue;
        out.push({
          key: `iv:${iv.id}`,
          category: isPlan ? 'plan' : 'develop',
          title: (isPlan ? PLAN_LABEL[iv.interview_type] : DEV_LABEL[iv.interview_type]) ?? 'AI session',
          detail: iv.topic,
          chapterId: iv.chapter_id,
          status: STATUS_LABEL[iv.status] ?? iv.status,
          date: iv.updated_at || iv.created_at,
          href: iv.interview_type === 'plan_chapter' && iv.chapter_id ? `${base}/plan/chapter/${iv.chapter_id}`
            : iv.interview_type === 'plan_new_book' ? `${base}/plan`
              : iv.chapter_id ? `${base}/chapters/${iv.chapter_id}` : undefined
        });
      }

      for (const o of (outlines.data ?? []) as { id: string; structure_type: string | null; version_number: number; is_current: boolean; note: string | null; created_at: string }[]) {
        out.push({
          key: `so:${o.id}`, category: 'plan',
          title: `Book outline v${o.version_number}${o.is_current ? ' · current' : ''}`,
          detail: o.note ?? o.structure_type,
          date: o.created_at, href: `${base}/plan`
        });
      }

      for (const o of (chOutlines.data ?? []) as { id: string; chapter_id: string; version_number: number; is_current: boolean; purpose: string | null; created_at: string }[]) {
        out.push({
          key: `co:${o.id}`, category: 'plan',
          title: `Chapter outline v${o.version_number}${o.is_current ? ' · current' : ''}`,
          detail: o.purpose ?? chapterLabel(o.chapter_id),
          chapterId: o.chapter_id,
          date: o.created_at, href: `${base}/plan/chapter/${o.chapter_id}`
        });
      }

      out.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setEvents(out);
    } catch { setError('Could not load history.'); }
  }, [supabase, book.id, chapters, base, chapterById, chapterLabel]);
  useEffect(() => { load(); }, [load]);

  const shown = (events ?? []).filter((e) => filter === 'all' || e.category === filter);
  const countOf = (key: 'all' | Category) => (events ?? []).filter((e) => key === 'all' || e.category === key).length;

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-7 lg:px-10">
      <p className="mb-1 font-display text-2xl text-ink">Activity History</p>
      <p className="mb-5 text-sm text-ink-soft">Every review, Develop This / Help Me Continue session, and plan you&apos;ve run on this book — newest first. Read-only; nothing here changes your manuscript.</p>

      {error && <div className="mb-4 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-accent-strong">{error}</div>}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const n = countOf(f.key);
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} className={`min-h-[36px] rounded-lg px-3 text-xs font-medium transition ${filter === f.key ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-black/5'}`}>
              {f.label}{n ? ` (${n})` : ''}
            </button>
          );
        })}
      </div>

      {events === null && <p className="py-10 text-center text-sm text-ink-faint">Loading…</p>}
      {events !== null && events.length === 0 && (
        <div className="rounded-xl border border-line bg-paper px-4 py-12 text-center">
          <p className="font-display text-lg text-ink">No activity yet.</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">Once you run a review, use Develop This or Help Me Continue, or plan a chapter, it will show up here.</p>
        </div>
      )}
      {events !== null && events.length > 0 && shown.length === 0 && (
        <p className="rounded-xl border border-line bg-paper px-4 py-8 text-center text-sm text-ink-soft">Nothing in this view. Try “All”.</p>
      )}

      <ul className="space-y-2.5">
        {shown.map((e) => {
          const chLabel = chapterLabel(e.chapterId);
          const inner = (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${CAT_CHIP[e.category]}`}>{CAT_LABEL[e.category]}</span>
                <span className="font-display text-base text-ink">{e.title}</span>
                {e.status && <span className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-faint">{e.status}</span>}
                <span className="ml-auto text-xs text-ink-faint">{relativeDate(e.date)}</span>
              </div>
              {(e.detail || chLabel) && (
                <p className="mt-1 line-clamp-2 text-sm text-ink-soft">
                  {e.detail ? <span>{e.detail}</span> : null}
                  {e.detail && chLabel ? <span className="text-ink-faint"> · </span> : null}
                  {chLabel && !e.detail?.includes(chLabel) ? <span className="text-ink-faint">{chLabel}</span> : null}
                </p>
              )}
            </>
          );
          return (
            <li key={e.key} className="rounded-xl border border-line bg-surface px-4 py-3">
              {e.href ? <Link href={e.href} className="block hover:opacity-90">{inner}</Link> : inner}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
