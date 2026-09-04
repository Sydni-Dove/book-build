/**
 * apply_paragraph_revision write-tool tests. Uses a THROWAWAY fixture book
 * (created + deleted here) — never mutates canonical Awakened prose. Covers
 * A successful exact revision, B stale target, C wrong original, D RLS (anon),
 * E wrong relationship, F snapshot failure (fake client), G surrounding
 * integrity, H multiple identical paragraphs.
 * Run: npx tsx scripts/apply-revision.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { splitParagraphs } from '../src/lib/ai/development/proseSignals.ts';
import { applyParagraphRevision } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svcKey, { auth: { persistSession: false } });

let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`); if (!cond) failures++; };
const status = (r: any) => (r.structuredContent as any).status;
const anchorId = (sid: string, content: string, text: string) => splitParagraphs(sid, content).find((p) => p.text === text)!.anchor.id;

async function mkSection(bookId: string, chapterId: string, content: string): Promise<string> {
  const { data } = await sb.from('writing_sections').insert({ chapter_id: chapterId, sort_order: 0, content, word_count: content.split(/\s+/).length }).select('id').single();
  return data!.id;
}
async function getContent(id: string) { const { data } = await sb.from('writing_sections').select('content').eq('id', id).single(); return data!.content; }

// ---- fixture ----
const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__apply_revision_test__', status: 'Planning' }).select('id').single();
const BOOK = book!.id;
const { data: chap } = await sb.from('chapters').insert({ book_id: BOOK, chapter_number: 1, title: 'T', sort_order: 0 }).select('id').single();
const CH = chap!.id;

try {
  // A · successful exact revision + G surrounding integrity + snapshot
  {
    const C = 'The teacher paused for a long moment.\n\nThat taught me.\n\nShe moved on to the next point.';
    const sec = await mkSection(BOOK, CH, C);
    const r = await applyParagraphRevision(sb, { book_id: BOOK, chapter_id: CH, section_id: sec, passage_anchor: anchorId(sec, C, 'That taught me.'), expected_original_text: 'That taught me.', approved_replacement_text: 'That stuck with me.', classification: 'CRAFT_CONCERN' });
    check('A: status applied', status(r) === 'applied');
    const after = await getContent(sec);
    check('A/G: only the target paragraph changed (surrounding byte-for-byte)', after === 'The teacher paused for a long moment.\n\nThat stuck with me.\n\nShe moved on to the next point.');
    const { data: vers } = await sb.from('section_versions').select('content, version_reason').eq('section_id', sec);
    check('A: exactly one pre-edit snapshot with OLD content', (vers?.length === 1) && vers![0]!.content === C && vers![0]!.version_reason === 'before_ai_edit');
  }

  // B · stale target
  {
    const C = 'Alpha.\n\nThat taught me.\n\nOmega.';
    const sec = await mkSection(BOOK, CH, C);
    const stale = anchorId(sec, C, 'That taught me.');
    await sb.from('writing_sections').update({ content: 'Alpha.\n\nAlready changed.\n\nOmega.' }).eq('id', sec); // text moved on
    const r = await applyParagraphRevision(sb, { book_id: BOOK, section_id: sec, passage_anchor: stale, expected_original_text: 'That taught me.', approved_replacement_text: 'X' });
    check('B: status TARGET_CHANGED', status(r) === 'TARGET_CHANGED');
    check('B: no write occurred', (await getContent(sec)) === 'Alpha.\n\nAlready changed.\n\nOmega.');
  }

  // C · wrong original text
  {
    const C = 'One.\n\nThat taught me.\n\nTwo.';
    const sec = await mkSection(BOOK, CH, C);
    const r = await applyParagraphRevision(sb, { book_id: BOOK, section_id: sec, passage_anchor: anchorId(sec, C, 'That taught me.'), expected_original_text: 'A completely different original line.', approved_replacement_text: 'X' });
    check('C: status WRONG_ORIGINAL', status(r) === 'WRONG_ORIGINAL');
    check('C: no write occurred', (await getContent(sec)) === C);

    // E · wrong book relationship (reuse section C, still intact)
    const rE = await applyParagraphRevision(sb, { book_id: '00000000-0000-0000-0000-000000000000', section_id: sec, passage_anchor: anchorId(sec, C, 'That taught me.'), expected_original_text: 'That taught me.', approved_replacement_text: 'X' });
    check('E: wrong book_id → WRONG_RELATIONSHIP', status(rE) === 'WRONG_RELATIONSHIP');

    // D · RLS: anon (no session) cannot even read the section → NOT_FOUND, no write
    const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
    const rD = await applyParagraphRevision(anon, { book_id: BOOK, section_id: sec, passage_anchor: anchorId(sec, C, 'That taught me.'), expected_original_text: 'That taught me.', approved_replacement_text: 'X' });
    check('D: anon/unauthorized blocked by RLS → NOT_FOUND', status(rD) === 'NOT_FOUND');
    check('D: no write occurred', (await getContent(sec)) === C);
  }

  // H · multiple identical paragraphs — only the anchored one changes
  {
    const C = 'That taught me.\n\nMiddle.\n\nThat taught me.';
    const sec = await mkSection(BOOK, CH, C);
    const paras = splitParagraphs(sec, C);
    const lastAnchor = paras[2]!.anchor.id; // second identical paragraph (index 2)
    const r = await applyParagraphRevision(sb, { book_id: BOOK, section_id: sec, passage_anchor: lastAnchor, expected_original_text: 'That taught me.', approved_replacement_text: 'Only the last one changed.' });
    check('H: status applied', status(r) === 'applied');
    check('H: exactly one occurrence changed (the anchored index)', (await getContent(sec)) === 'That taught me.\n\nMiddle.\n\nOnly the last one changed.');
  }

  // F · snapshot failure (fake client) — update must NOT proceed
  {
    let updateCalled = false;
    const C = 'A.\n\nThat taught me.\n\nB.';
    const fake: any = {
      from(table: string) {
        const builder: any = {
          _t: table,
          select() { return builder; },
          eq() { return builder; },
          insert() { return builder; },
          update() { updateCalled = true; return builder; },
          maybeSingle() {
            if (table === 'writing_sections') return Promise.resolve({ data: { id: 'sec', chapter_id: 'ch', content: C }, error: null });
            if (table === 'chapters') return Promise.resolve({ data: { id: 'ch', book_id: 'bk' }, error: null });
            return Promise.resolve({ data: null, error: null });
          },
          single() {
            if (table === 'section_versions') return Promise.resolve({ data: null, error: { message: 'forced snapshot failure' } });
            return Promise.resolve({ data: { updated_at: 'now', word_count: 1 }, error: null });
          }
        };
        return builder;
      }
    };
    const r = await applyParagraphRevision(fake, { book_id: 'bk', section_id: 'sec', passage_anchor: anchorId('sec', C, 'That taught me.'), expected_original_text: 'That taught me.', approved_replacement_text: 'X' });
    check('F: status SNAPSHOT_FAILED', status(r) === 'SNAPSHOT_FAILED');
    check('F: manuscript update NOT attempted after snapshot failure', updateCalled === false);
  }
} finally {
  await sb.from('books').delete().eq('id', BOOK); // cascade removes chapters/sections/section_versions
  console.log('\n(fixture cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
