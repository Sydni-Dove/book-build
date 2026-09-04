/**
 * Append/replace chapters into an ALREADY-IMPORTED manuscript (reusable).
 *
 * The general "import chapters from other places" path. Source-agnostic: it
 * reads a manifest of {chapter_number, title, source_url, file} where `file` is
 * a UTF-8 text file of that chapter's verbatim prose. Sections split on the
 * manuscript's own "~~~" scene breaks (else one section) — identical rule to
 * the whole-manuscript importer. Prose is never rewritten/summarized.
 *
 * Behavior per chapter:
 *   - new chapter_number  → INSERT chapter (sort_order = max+1) + sections
 *   - existing            → REPLACE its sections (and title) IN PLACE, keeping
 *                           the same chapter_id (so outline/import links survive).
 *                           REFUSES if any of its sections were edited since
 *                           import (updated_at > created_at) unless --force.
 * Provenance: one manuscript_imports row per source (file_hash = sha256 of the
 * file; unique(book_id,file_hash) makes identical re-imports idempotent) +
 * import_chapters link. Nothing is written to story-bible/canon tables.
 *
 * Run: npx tsx scripts/import-chapters.mts scripts/data/append-manifest.json [--force]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';

const MANIFEST = process.argv[2] ?? 'scripts/data/append-manifest.json';
const FORCE = process.argv.includes('--force');
const BOOK_ID = process.env.BOOK_ID ?? '69c4e5ca-2529-4aab-9126-32873894d804';
const OWNER_ID = process.env.OWNER_ID ?? '31271b9c-39f9-499e-a96c-c2e77661ee98';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }
const sb = createClient<Database>(url, key, { auth: { persistSession: false } });

const wordCount = (t: string) => { const s = t.trim(); return s ? s.split(/\s+/).length : 0; };
const splitSections = (raw: string) =>
  raw.split(/\n?~+(?:\s*~+)*\n/).map((s) => s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean);

type Entry = { chapter_number: number; title: string; source_url: string; file: string };
const manifest: Entry[] = JSON.parse(readFileSync(MANIFEST, 'utf8'));

for (const e of manifest) {
  const raw = readFileSync(e.file, 'utf8');
  const fileHash = createHash('sha256').update(raw).digest('hex');
  const sections = splitSections(raw).map((content, i) => ({ sort_order: i, content, word_count: wordCount(content) }));
  if (!sections.length) { console.log(`Ch${e.chapter_number}: no content, skipped`); continue; }

  const { data: existing } = await sb
    .from('chapters').select('id, created_at, sort_order')
    .eq('book_id', BOOK_ID).eq('chapter_number', e.chapter_number).maybeSingle();

  let chapterId: string;
  if (existing) {
    // Refuse to clobber writer edits.
    const { data: secs } = await sb.from('writing_sections').select('created_at, updated_at').eq('chapter_id', existing.id);
    const edited = (secs ?? []).some((s) => new Date(s.updated_at).getTime() - new Date(s.created_at).getTime() > 1500);
    if (edited && !FORCE) { console.error(`Ch${e.chapter_number}: existing sections were edited since import — refusing (use --force to override).`); continue; }
    await sb.from('writing_sections').delete().eq('chapter_id', existing.id);
    await sb.from('chapters').update({ title: e.title, status: 'Drafting' }).eq('id', existing.id);
    chapterId = existing.id;
    console.log(`Ch${e.chapter_number}: REPLACED "${e.title}" (${sections.length} section(s))`);
  } else {
    const { data: maxRow } = await sb.from('chapters').select('sort_order').eq('book_id', BOOK_ID).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const nextSort = (maxRow?.sort_order ?? -1) + 1;
    const { data: chap, error } = await sb.from('chapters')
      .insert({ book_id: BOOK_ID, chapter_number: e.chapter_number, title: e.title, sort_order: nextSort, status: 'Drafting' })
      .select().single();
    if (error || !chap) { console.error(`Ch${e.chapter_number}: insert failed`, error); continue; }
    chapterId = chap.id;
    console.log(`Ch${e.chapter_number}: ADDED "${e.title}" (${sections.length} section(s))`);
  }

  const { error: sErr } = await sb.from('writing_sections')
    .insert(sections.map((s) => ({ chapter_id: chapterId, sort_order: s.sort_order, content: s.content, word_count: s.word_count, status: 'Draft' as const })));
  if (sErr) { console.error(`Ch${e.chapter_number}: section insert failed`, sErr); continue; }

  // Provenance (idempotent on unique(book_id,file_hash)).
  const { data: imp } = await sb.from('manuscript_imports')
    .insert({ book_id: BOOK_ID, owner_user_id: OWNER_ID, storage_path: e.source_url, original_filename: `${e.title} (Notion)`, file_hash: fileHash, mime_type: 'text/markdown', processing_state: 'complete' })
    .select().maybeSingle();
  if (imp) await sb.from('import_chapters').insert({ import_id: imp.id, sequence_index: 0, detected_title: `Chapter ${e.chapter_number}: ${e.title}`, source_char_start: 0, source_char_end: raw.length, chapter_id: chapterId, sections_materialized: true });
}
console.log('done.');
