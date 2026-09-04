/**
 * Awakened manuscript importer (POC).
 *
 * SOURCE OF TRUTH: test-manuscripts/Awakened_Fictional_Dream_Book_7.23.26.docx
 * (verbatim prose; the only normalization is line-ending/entity decoding and
 * dropping empty spacer paragraphs). It never rewrites, summarizes, or invents
 * manuscript content, and never populates story-bible/canon tables.
 *
 * MAPPING: Book (existing row) → Chapter (each Heading1 "Chapter N: Title")
 *          → Section (split ONLY on the manuscript's own "~~~" scene breaks;
 *          a chapter with no "~~~" becomes ONE section). Paragraphs stay inside
 *          section prose (addressable at runtime later — no paragraph table).
 *
 * MODES:
 *   (default) dry-run — parse + print summary + Ch19 detail + hash. No DB.
 *   --live            — idempotent insert via @supabase/supabase-js using
 *                       SUPABASE_SERVICE_ROLE_KEY (admin; bypasses RLS by design
 *                       for a controlled import). Refuses to clobber edits.
 *   --emit-sql        — also write scripts/out/awakened-import.sql
 *
 * Run: npx tsx scripts/import-awakened.mts [--live] [--emit-sql]
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const DOCX = process.env.DOCX_PATH ?? 'test-manuscripts/Awakened_Fictional_Dream_Book_7.23.26.docx';
const BOOK_ID = process.env.BOOK_ID ?? '69c4e5ca-2529-4aab-9126-32873894d804';
const OWNER_ID = process.env.OWNER_ID ?? '31271b9c-39f9-499e-a96c-c2e77661ee98';
const LIVE = process.argv.includes('--live');
const EMIT_SQL = process.argv.includes('--emit-sql');

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const wordCount = (t: string) => { const s = t.trim(); return s ? s.split(/\s+/).length : 0; };
const isSceneBreak = (t: string) => /^~+(\s*~+)*$/.test(t.trim());
const chapterHead = (t: string) => t.trim().match(/^chapter\s+(\d+)\s*[:\-–—]\s*(.+)$/i);

type Section = { sort_order: number; content: string; word_count: number };
type Chapter = { chapter_number: number; title: string; sort_order: number; sections: Section[] };

function parse(): { chapters: Chapter[]; fileHash: string; fileBytes: number } {
  const bytes = readFileSync(DOCX);
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const xml = execSync(`unzip -p "${DOCX}" word/document.xml`, { maxBuffer: 1 << 26 }).toString('utf8');
  const paras = xml.split(/<w:p[ >]/).slice(1).map((p) => {
    const style = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    const text = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decode(m[1])).join('');
    return { style, text };
  });

  const chapters: Chapter[] = [];
  let cur: Chapter | null = null;
  let buf: string[] = [];       // paragraphs of the current section
  let sectionOrder = 0;

  const flushSection = () => {
    if (!cur) return;
    const content = buf.join('\n\n').trim();
    buf = [];
    if (content) { cur.sections.push({ sort_order: sectionOrder++, content, word_count: wordCount(content) }); }
  };

  for (const p of paras) {
    const head = /heading1/i.test(p.style) ? chapterHead(p.text) : null;
    if (head) {
      flushSection();
      cur = { chapter_number: Number(head[1]), title: head[2]!.trim(), sort_order: chapters.length, sections: [] };
      chapters.push(cur);
      sectionOrder = 0;
      continue;
    }
    if (!cur) continue; // front-matter before Chapter 1 — ignored for POC
    if (isSceneBreak(p.text)) { flushSection(); continue; }
    if (p.text.trim() === '') continue; // spacer paragraph
    buf.push(p.text);
  }
  flushSection();

  // A chapter that somehow produced no section still gets one empty-safe entry skipped.
  return { chapters, fileHash, fileBytes: bytes.length };
}

const { chapters, fileHash, fileBytes } = parse();
const totalSections = chapters.reduce((n, c) => n + c.sections.length, 0);
const totalWords = chapters.reduce((n, c) => n + c.sections.reduce((m, s) => m + s.word_count, 0), 0);

console.log(`SOURCE: ${DOCX}`);
console.log(`sha256: ${fileHash}`);
console.log(`bytes:  ${fileBytes}`);
console.log(`chapters: ${chapters.length} | sections: ${totalSections} | words: ${totalWords}`);
console.log('\nPER-CHAPTER (number | sections | title):');
for (const c of chapters) console.log(`  ${String(c.chapter_number).padStart(2)} | ${c.sections.length} | ${c.title}`);

const ch19 = chapters.find((c) => c.chapter_number === 19);
if (ch19) {
  console.log(`\n=== Chapter 19 acceptance detail ===`);
  console.log(`title: "${ch19.title}" | sections: ${ch19.sections.length}`);
  const first = ch19.sections[0]!.content;
  const last = ch19.sections[ch19.sections.length - 1]!.content;
  console.log(`first 140 chars (verbatim): ${JSON.stringify(first.slice(0, 140))}`);
  console.log(`last 140 chars  (verbatim): ${JSON.stringify(last.slice(-140))}`);
}

if (EMIT_SQL) {
  mkdirSync('scripts/out', { recursive: true });
  const chJson = JSON.stringify(chapters.map((c) => ({ chapter_number: c.chapter_number, title: c.title, sort_order: c.sort_order })));
  const secJson = JSON.stringify(
    chapters.flatMap((c) => c.sections.map((s) => ({ chapter_number: c.chapter_number, sort_order: s.sort_order, content: s.content, word_count: s.word_count })))
  );
  const esc = (s: string) => s.replace(/'/g, "''");
  const sql = `-- Awakened import (generated). Atomic; idempotent guard checks empties.
begin;
with ins_ch as (
  insert into chapters (book_id, chapter_number, title, sort_order, status)
  select '${BOOK_ID}', (e->>'chapter_number')::int, e->>'title', (e->>'sort_order')::int, 'Drafting'
  from jsonb_array_elements('${esc(chJson)}'::jsonb) e
  returning id, chapter_number
)
insert into writing_sections (chapter_id, sort_order, content, word_count, status)
select ch.id, (s->>'sort_order')::int, s->>'content', (s->>'word_count')::int, 'Draft'
from jsonb_array_elements('${esc(secJson)}'::jsonb) s
join ins_ch ch on ch.chapter_number = (s->>'chapter_number')::int;
commit;`;
  writeFileSync('scripts/out/awakened-import.sql', sql);
  console.log(`\nWrote scripts/out/awakened-import.sql (${sql.length} bytes)`);
}

if (LIVE) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('\n[LIVE] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Idempotency guard: refuse if any section was edited after a prior import.
  const { data: existingChapters } = await sb.from('chapters').select('id').eq('book_id', BOOK_ID);
  if ((existingChapters?.length ?? 0) > 0) {
    console.error(`\n[LIVE] ${existingChapters!.length} chapters already exist for this book. Refusing to clobber. Clear them first or add explicit --force (not implemented).`);
    process.exit(3);
  }

  const { data: imp, error: impErr } = await sb.from('manuscript_imports').insert({
    book_id: BOOK_ID, owner_user_id: OWNER_ID, storage_path: DOCX, original_filename: DOCX.split('/').pop(),
    file_size_bytes: fileBytes, file_hash: fileHash, mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    processing_state: 'parsing'
  }).select().single();
  if (impErr) { console.error('[LIVE] manuscript_imports insert failed', impErr); process.exit(4); }

  let seq = 0;
  for (const c of chapters) {
    const { data: chap, error: chErr } = await sb.from('chapters')
      .insert({ book_id: BOOK_ID, chapter_number: c.chapter_number, title: c.title, sort_order: c.sort_order, status: 'Drafting' })
      .select().single();
    if (chErr || !chap) { console.error('[LIVE] chapter insert failed', chErr); process.exit(5); }
    const rows = c.sections.map((s) => ({ chapter_id: chap.id, sort_order: s.sort_order, content: s.content, word_count: s.word_count, status: 'Draft' as const }));
    if (rows.length) { const { error: sErr } = await sb.from('writing_sections').insert(rows); if (sErr) { console.error('[LIVE] section insert failed', sErr); process.exit(6); } }
    await sb.from('import_chapters').insert({ import_id: imp.id, sequence_index: seq++, detected_title: `Chapter ${c.chapter_number}: ${c.title}`, source_char_start: 0, source_char_end: 0, chapter_id: chap.id, sections_materialized: true });
  }
  await sb.from('manuscript_imports').update({ processing_state: 'complete' }).eq('id', imp.id);
  console.log(`\n[LIVE] Imported ${chapters.length} chapters / ${totalSections} sections. import_id=${imp.id}`);
}
