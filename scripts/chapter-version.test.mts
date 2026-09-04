/**
 * Chapter version upload tests (parse + match + atomic apply). Fixtures only —
 * never touches canonical Awakened prose. Requires migration 0005 (chapter_versions
 * + apply_chapter_version RPC). Run: npx tsx scripts/chapter-version.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { previewChapterVersion, applyChapterVersion } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;

const S1 = 'Chapter opens on a quiet morning.\n\nDaniella made her coffee slowly.';
const S2 = 'At church, the worship swelled.\n\nShe felt the old ache return.';
const S3 = 'That night she wrote it all down.\n\nThe page filled with questions.';
const join = (...xs: string[]) => xs.join('\n\n~~~\n\n');

const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__chapter_version_test__', status: 'Planning' }).select('id').single();
const BOOK = book!.id;
const mkChapter = async (n: number, secs: string[]) => {
  const { data: ch } = await sb.from('chapters').insert({ book_id: BOOK, chapter_number: n, title: `Ch${n}`, sort_order: n }).select('id').single();
  await sb.from('writing_sections').insert(secs.map((content, i) => ({ chapter_id: ch!.id, sort_order: i, content, word_count: content.split(/\s+/).length, title: null })));
  return ch!.id;
};
const secsOf = async (chId: string) => (await sb.from('writing_sections').select('id, sort_order, content, word_count').eq('chapter_id', chId).order('sort_order')).data ?? [];
const cvCount = async (chId: string) => ((await sb.from('section_versions').select('id')), (await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', chId)).count ?? 0);

try {
  // A · identical upload → UNCHANGED, no write
  const chA = await mkChapter(1, [S1, S2, S3]);
  const pa = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chA, incoming_content: join(S1, S2, S3) });
  check('A: identical → preview UNCHANGED', st(pa) === 'UNCHANGED');
  const aHash = sc(pa).chapter_hash;
  const aa = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chA, incoming_content: join(S1, S2, S3), expected_chapter_hash: aHash });
  check('A: identical → apply UNCHANGED (no write)', st(aa) === 'UNCHANGED');
  check('A: no chapter_version snapshot created', (await cvCount(chA)) === 0);

  // B · one modified section → only that change
  const chB = await mkChapter(2, [S1, S2, S3]);
  const S2b = 'At church, the worship swelled louder than ever.\n\nShe felt something break open.';
  const pb = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chB, incoming_content: join(S1, S2b, S3) });
  check('B: summary 1 modified / 2 unchanged / 0 new / 0 missing', sc(pb).summary.modified === 1 && sc(pb).summary.unchanged === 2 && sc(pb).summary.added === 0 && sc(pb).summary.missing === 0);
  const before = await secsOf(chB);
  const ab = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chB, incoming_content: join(S1, S2b, S3), expected_chapter_hash: sc(pb).chapter_hash });
  check('B: apply status applied', st(ab) === 'applied');
  const after = await secsOf(chB);
  check('B: only S2 changed', after[0]!.content === S1 && after[1]!.content === S2b && after[2]!.content === S3);
  check('B: applied_updates == 1', sc(ab).applied_updates === 1);
  // H · snapshot exists first, capturing pre-apply content
  const { data: snapRow } = await sb.from('chapter_versions').select('snapshot, version_reason').eq('id', sc(ab).chapter_version_id).single();
  const snapSecs = (snapRow!.snapshot as any).sections;
  check('H: snapshot captured pre-apply chapter (original S2 present)', snapSecs.length === 3 && snapSecs[1].content === S2);
  check('H: snapshot reason is human-mappable (before_chapter_upload)', snapRow!.version_reason === 'before_chapter_upload');

  // C · multiple modified → each diff correct
  const chC = await mkChapter(3, [S1, S2, S3]);
  const pc = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chC, incoming_content: join(S1 + ' Edited.', S2 + ' Edited.', S3 + ' Edited.') });
  check('C: 3 modified', sc(pc).summary.modified === 3);
  check('C: each modified section has a diff with additions', sc(pc).sections.filter((s: any) => s.role === 'modified').every((s: any) => s.summary.paragraphs_added > 0 || s.summary.paragraphs_removed > 0));

  // D · new section → surfaced, then created
  const chD = await mkChapter(4, [S1, S2]);
  const NEW = 'A brand new scene appears.\n\nNo one saw it coming.';
  const pd = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chD, incoming_content: join(S1, S2, NEW) });
  check('D: new section surfaced (added=1)', sc(pd).summary.added === 1 && sc(pd).sections.some((s: any) => s.role === 'added'));
  const ad = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chD, incoming_content: join(S1, S2, NEW), expected_chapter_hash: sc(pd).chapter_hash });
  check('D: apply inserted 1', st(ad) === 'applied' && sc(ad).inserted === 1);
  const afterD = await secsOf(chD);
  check('D: new section is last with its content', afterD.length === 3 && afterD[2]!.content === NEW);

  // E · existing section absent from upload → preserved by default, not reordered
  const chE = await mkChapter(5, [S1, S2, S3]);
  const pe = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chE, incoming_content: join(S1, S3) });
  check('E: missing surfaced (missing=1)', sc(pe).summary.missing === 1 && sc(pe).sections.some((s: any) => s.role === 'missing'));
  check('E: preserved section does NOT count as reorder', sc(pe).reordered === false);
  const ae = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chE, incoming_content: join(S1, S3), expected_chapter_hash: sc(pe).chapter_hash });
  const afterE = await secsOf(chE);
  check('E: S2 preserved by default (still 3 sections, order intact)', afterE.length === 3 && afterE.map((s) => s.content).join('|') === [S1, S2, S3].join('|'));
  check('E: apply removed 0', st(ae) === 'UNCHANGED' || sc(ae).removed === 0);

  // E2 · explicit removal opt-in
  const chE2 = await mkChapter(6, [S1, S2, S3]);
  const pe2 = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chE2, incoming_content: join(S1, S3) });
  const missingId = sc(pe2).sections.find((s: any) => s.role === 'missing').section_id;
  const ae2 = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chE2, incoming_content: join(S1, S3), expected_chapter_hash: sc(pe2).chapter_hash, removals: [missingId] });
  const afterE2 = await secsOf(chE2);
  check('E2: explicit removal deletes exactly the chosen section', st(ae2) === 'applied' && sc(ae2).removed === 1 && afterE2.length === 2 && afterE2.map((s) => s.content).join('|') === [S1, S3].join('|'));

  // F · reorder (same contents, new order)
  const chF = await mkChapter(7, [S1, S2, S3]);
  const pf = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chF, incoming_content: join(S2, S1, S3) });
  check('F: reorder detected, 0 modified/new/missing', sc(pf).reordered === true && sc(pf).summary.modified === 0 && sc(pf).summary.added === 0 && sc(pf).summary.missing === 0);
  const af = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chF, incoming_content: join(S2, S1, S3), expected_chapter_hash: sc(pf).chapter_hash });
  const afterF = await secsOf(chF);
  check('F: order now S2,S1,S3', st(af) === 'applied' && afterF.map((s) => s.content).join('|') === [S2, S1, S3].join('|'));

  // G · preview mutates nothing
  const chG = await mkChapter(8, [S1, S2, S3]);
  await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chG, incoming_content: join(S1 + ' x', S2 + ' y', NEW) });
  const afterG = await secsOf(chG);
  check('G: preview did not write', afterG.map((s) => s.content).join('|') === [S1, S2, S3].join('|') && (await cvCount(chG)) === 0);

  // J · failure mid-apply → full rollback (no snapshot, no partial)
  const chJ = await mkChapter(9, [S1, S2, S3]);
  const hJ = sc(await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chJ, incoming_content: join(S1, S2, S3) })).chapter_hash;
  const cvBefore = await cvCount(chJ);
  const { error: jErr } = await sb.rpc('apply_chapter_version', {
    p_book_id: BOOK, p_chapter_id: chJ, p_expected_hash: hJ,
    p_updates: [{ section_id: 'not-a-uuid', content: 'x', word_count: 1 }], p_inserts: [], p_order: [], p_removals: [], p_version_reason: 'before_chapter_upload'
  } as any);
  check('J: bad update aborts the transaction', !!jErr);
  check('J: no partial — snapshot rolled back too', (await cvCount(chJ)) === cvBefore);
  check('J: chapter content untouched after failed apply', (await secsOf(chJ)).map((s) => s.content).join('|') === [S1, S2, S3].join('|'));

  // K · stale: chapter changed after preview → apply rejected
  const chK = await mkChapter(10, [S1, S2, S3]);
  const pk = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: chK, incoming_content: join(S1 + ' edit', S2, S3) });
  const kSecs = await secsOf(chK);
  await sb.from('writing_sections').update({ content: 'Changed underneath.' }).eq('id', kSecs[0]!.id);
  const ak = await applyChapterVersion(sb, { book_id: BOOK, chapter_id: chK, incoming_content: join(S1 + ' edit', S2, S3), expected_chapter_hash: sc(pk).chapter_hash });
  check('K: stale apply → TARGET_CHANGED', st(ak) === 'TARGET_CHANGED');
  check('K: no write on stale', (await secsOf(chK))[0]!.content === 'Changed underneath.');

  // L · a section from another chapter cannot be modified through this operation
  const chL = await mkChapter(11, [S1]);
  const chOther = await mkChapter(12, ['Other chapter content, protected.']);
  const otherId = (await secsOf(chOther))[0]!.id;
  const { data: lData } = await sb.rpc('apply_chapter_version', {
    p_book_id: BOOK, p_chapter_id: chL, p_expected_hash: '',
    p_updates: [{ section_id: otherId, content: 'HACKED', word_count: 1 }], p_inserts: [], p_order: [], p_removals: [otherId], p_version_reason: 'before_chapter_upload'
  } as any);
  check('L: cross-chapter update/removal is a no-op', (lData as any).applied_updates === 0 && (lData as any).removed === 0);
  check('L: other chapter section untouched', (await secsOf(chOther))[0]!.content === 'Other chapter content, protected.');
} finally {
  await sb.from('books').delete().eq('id', BOOK);
  console.log('\n(fixture cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
