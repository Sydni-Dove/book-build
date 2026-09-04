/**
 * Section version upload tests (preview + apply). Fixtures only — never mutates
 * canonical Awakened prose. Run: npx tsx scripts/section-version.test.mts
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { previewSectionVersion, applySectionVersion } from '../src/lib/mcp/tools.ts';
import { extractText, parseDocxXml } from '../src/lib/ingest/extractText.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;
const getContent = async (id: string) => (await sb.from('writing_sections').select('content').eq('id', id).single()).data!.content;

const CUR = 'Daniella walked in slowly.\n\nThe room was quiet.\n\nShe found a seat.';
const NEW = 'Daniella walked in.\n\nThe room was quiet and warm.\n\nShe found a seat near the front.';

const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__section_version_test__', status: 'Planning' }).select('id').single();
const BOOK = book!.id;
const { data: chap } = await sb.from('chapters').insert({ book_id: BOOK, chapter_number: 1, title: 'T', sort_order: 0 }).select('id').single();
const CH = chap!.id;
const mk = async (content: string, order: number) => (await sb.from('writing_sections').insert({ chapter_id: CH, sort_order: order, content, word_count: content.split(/\s+/).length }).select('id').single()).data!.id;

try {
  const target = await mk(CUR, 0);
  const sibling = await mk('Sibling content, untouched.', 1);

  // A · preview changed (+ no mutation)
  const pa = await previewSectionVersion(sb, { book_id: BOOK, chapter_id: CH, section_id: target, incoming_content: NEW });
  check('A: preview status changed', st(pa) === 'changed');
  check('A: diff has added and removed lines', sc(pa).summary.paragraphs_added > 0 && sc(pa).summary.paragraphs_removed > 0);
  check('A: word counts before/after present', typeof sc(pa).word_count_before === 'number' && typeof sc(pa).word_count_after === 'number');
  check('A: no DB mutation during preview', (await getContent(target)) === CUR);

  // B · preview identical → UNCHANGED
  const pb = await previewSectionVersion(sb, { book_id: BOOK, section_id: target, incoming_content: CUR });
  check('B: identical → UNCHANGED', st(pb) === 'UNCHANGED');

  // C · successful apply (+ G surrounding integrity, snapshot holds old)
  const hash = sc(pa).current.content_hash;
  const ca = await applySectionVersion(sb, { book_id: BOOK, chapter_id: CH, section_id: target, expected_content_hash: hash, approved_content: NEW });
  check('C: apply status applied', st(ca) === 'applied');
  check('C: section now holds new content', (await getContent(target)) === NEW);
  const { data: vers } = await sb.from('section_versions').select('content, version_reason').eq('section_id', target);
  check('C: snapshot holds OLD content (manual_snapshot)', vers?.length === 1 && vers![0]!.content === CUR && vers![0]!.version_reason === 'manual_snapshot');
  check('J: sibling section byte-for-byte unchanged', (await getContent(sibling)) === 'Sibling content, untouched.');

  // D · stale preview
  const t2 = await mk('Original two.\n\nSecond paragraph.', 2);
  const p2 = await previewSectionVersion(sb, { book_id: BOOK, section_id: t2, incoming_content: 'New two.' });
  await sb.from('writing_sections').update({ content: 'Changed underneath.\n\nSecond paragraph.' }).eq('id', t2);
  const d = await applySectionVersion(sb, { book_id: BOOK, section_id: t2, expected_content_hash: sc(p2).current.content_hash, approved_content: 'New two.' });
  check('D: stale → TARGET_CHANGED', st(d) === 'TARGET_CHANGED');
  check('D: no overwrite', (await getContent(t2)) === 'Changed underneath.\n\nSecond paragraph.');

  // F · wrong relationship
  const f = await applySectionVersion(sb, { book_id: '00000000-0000-0000-0000-000000000000', section_id: t2, expected_content_hash: '', approved_content: 'X' });
  check('F: wrong book_id → WRONG_RELATIONSHIP', st(f) === 'WRONG_RELATIONSHIP');

  // G · unauthorized (anon) → NOT_FOUND, no write
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const g = await applySectionVersion(anon, { book_id: BOOK, section_id: t2, expected_content_hash: '', approved_content: 'X' });
  check('G: anon blocked by RLS → NOT_FOUND', st(g) === 'NOT_FOUND');

  // E · snapshot failure (fake client) → no update
  {
    let updateCalled = false;
    const fake: any = { from(table: string) { const b: any = { select: () => b, eq: () => b, insert: () => b, update: () => { updateCalled = true; return b; }, maybeSingle: () => Promise.resolve({ data: table === 'writing_sections' ? { id: 'sec', chapter_id: 'ch', content: 'Current.', updated_at: 't' } : table === 'chapters' ? { id: 'ch', book_id: 'bk' } : null, error: null }), single: () => Promise.resolve(table === 'section_versions' ? { data: null, error: { message: 'forced' } } : { data: { updated_at: 'n', word_count: 1 }, error: null }) }; return b; } };
    const e = await applySectionVersion(fake, { book_id: 'bk', section_id: 'sec', expected_content_hash: '', approved_content: 'Different text.' });
    check('E: snapshot failure → SNAPSHOT_FAILED', st(e) === 'SNAPSHOT_FAILED');
    check('E: no section update after snapshot failure', updateCalled === false);
  }

  // H · DOCX extraction — one section body, "~~~" preserved as content (not split)
  const dir = mkdtempSync(join(tmpdir(), 'svtest-'));
  mkdirSync(join(dir, 'word'), { recursive: true });
  writeFileSync(join(dir, 'word', 'document.xml'), '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Para one.</w:t></w:r></w:p><w:p><w:r><w:t>~~~</w:t></w:r></w:p><w:p><w:r><w:t>Para two.</w:t></w:r></w:p></w:body></w:document>');
  execSync('zip -q -r fixture.docx word', { cwd: dir });
  const docxText = extractText({ filePath: join(dir, 'fixture.docx') });
  check('H: docx body extracted, "~~~" preserved as ONE section body', docxText === 'Para one.\n\n~~~\n\nPara two.');
  check('H: parseDocxXml is the shared parser', parseDocxXml('<w:p><w:t>Solo.</w:t></w:p>') === 'Solo.');

  // I · txt/md/paste all normalize to the same text
  writeFileSync(join(dir, 'a.txt'), 'Line one.\r\nLine two.');
  writeFileSync(join(dir, 'a.md'), 'Line one.\r\nLine two.');
  const fromTxt = extractText({ filePath: join(dir, 'a.txt') });
  const fromMd = extractText({ filePath: join(dir, 'a.md') });
  const fromPaste = extractText({ text: 'Line one.\r\nLine two.' });
  check('I: txt/md/paste normalize identically', fromTxt === 'Line one.\nLine two.' && fromMd === fromTxt && fromPaste === fromTxt);
} finally {
  await sb.from('books').delete().eq('id', BOOK);
  console.log('\n(fixture cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
