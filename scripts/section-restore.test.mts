/**
 * Section version HISTORY + RESTORE tests. Fixtures only — never mutates
 * canonical Awakened prose. Reuses the SAME section_versions history that
 * Upload writes to. Run: npx tsx scripts/section-restore.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import {
  applySectionVersion,
  listSectionVersions,
  previewSectionRestore,
  applySectionRestore
} from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;
const getContent = async (id: string) => (await sb.from('writing_sections').select('content').eq('id', id).single()).data!.content;
const rawVersions = async (id: string) => (await sb.from('section_versions').select('content, created_at').eq('section_id', id)).data ?? [];

const V1 = 'Version one.\n\nAlpha paragraph.';
const V2 = 'Version two.\n\nBeta paragraph.';
const V3 = 'Version three.\n\nGamma paragraph.';

const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__section_restore_test__', status: 'Planning' }).select('id').single();
const BOOK = book!.id;
const { data: chap } = await sb.from('chapters').insert({ book_id: BOOK, chapter_number: 1, title: 'T', sort_order: 0 }).select('id').single();
const CH = chap!.id;
const mk = async (content: string, order: number) => (await sb.from('writing_sections').insert({ chapter_id: CH, sort_order: order, content, word_count: content.split(/\s+/).length }).select('id').single()).data!.id;
const listV = async (sec: string) => sc(await listSectionVersions(sb, { book_id: BOOK, section_id: sec })).versions as any[];

try {
  // A · a fresh section with no uploads → empty history
  const empty = await mk('Solo, no history.', 0);
  const la = await listSectionVersions(sb, { book_id: BOOK, section_id: empty });
  check('A: no history → status ok, count 0', st(la) === 'ok' && sc(la).count === 0 && sc(la).versions.length === 0);
  check('A: current metadata present (word count + hash)', typeof sc(la).current.word_count === 'number' && typeof sc(la).current.content_hash === 'string');

  // Build history on target: V1 → V2 → V3 (each upload snapshots the prior).
  const target = await mk(V1, 1);
  await applySectionVersion(sb, { book_id: BOOK, chapter_id: CH, section_id: target, expected_content_hash: '', approved_content: V2 });
  await applySectionVersion(sb, { book_id: BOOK, chapter_id: CH, section_id: target, expected_content_hash: '', approved_content: V3 });

  // B · multiple versions, newest first
  const versions = await listV(target);
  check('B: two saved versions', versions.length === 2);
  check('B: newest first (V2 before V1)', versions[0].excerpt.startsWith('Version two.') && versions[1].excerpt.startsWith('Version one.'));
  check('B: sorted by created_at desc', versions[0].created_at >= versions[1].created_at);
  check('B: reason translated (no raw db term)', versions[0].version_reason === 'manual_snapshot' && typeof versions[0].word_count === 'number');
  const v1Id = versions[1].id; // the oldest historical version (content V1)

  // C · open historical version → current(V3) vs selected(V1) preview
  const pc = await previewSectionRestore(sb, { book_id: BOOK, chapter_id: CH, section_id: target, version_id: v1Id });
  check('C: preview status changed', st(pc) === 'changed');
  check('C: diff has additions and removals', sc(pc).summary.paragraphs_added > 0 && sc(pc).summary.paragraphs_removed > 0);
  check('C: current + selected word counts present', typeof sc(pc).word_count_before === 'number' && typeof sc(pc).word_count_after === 'number');
  check('C: selected carries created_at + reason', typeof sc(pc).selected.created_at === 'string' && sc(pc).selected.version_reason === 'manual_snapshot');

  // D · preview mutates nothing
  check('D: section unchanged after preview (still V3)', (await getContent(target)) === V3);

  // E/F/G · restore V1 over current V3
  const preHash = sc(pc).current.content_hash;
  const restore = await applySectionRestore(sb, { book_id: BOOK, chapter_id: CH, section_id: target, version_id: v1Id, expected_content_hash: preHash });
  check('E: restore status applied', st(restore) === 'applied');
  const afterRestore = await rawVersions(target);
  check('E: current content (V3) snapshotted FIRST', afterRestore.some((v) => v.content === V3));
  check('F: restored content is now live (V1)', (await getContent(target)) === V1);
  const versAfter = await listV(target);
  check('G: pre-restore version (V3) now appears in history', versAfter.some((v) => v.excerpt.startsWith('Version three.')));

  // H · restore is reversible — restore the just-snapshotted V3 back
  const v3Row = versAfter.find((v) => v.excerpt.startsWith('Version three.'))!;
  const p2 = await previewSectionRestore(sb, { book_id: BOOK, section_id: target, version_id: v3Row.id });
  const restore2 = await applySectionRestore(sb, { book_id: BOOK, section_id: target, version_id: v3Row.id, expected_content_hash: sc(p2).current.content_hash });
  check('H: second restore applied', st(restore2) === 'applied');
  check('H: previous state (V3) recovered as live', (await getContent(target)) === V3);

  // I · stale current section between preview and restore
  const sBase = 'Stale base.\n\nPara.';
  const stale = await mk(sBase, 2);
  await applySectionVersion(sb, { book_id: BOOK, section_id: stale, expected_content_hash: '', approved_content: 'Stale v2.\n\nPara.' });
  const staleVers = await listV(stale);
  const staleVerId = staleVers[0].id; // holds sBase
  const ps = await previewSectionRestore(sb, { book_id: BOOK, section_id: stale, version_id: staleVerId });
  await sb.from('writing_sections').update({ content: 'Changed underneath.\n\nPara.' }).eq('id', stale);
  const staleRestore = await applySectionRestore(sb, { book_id: BOOK, section_id: stale, version_id: staleVerId, expected_content_hash: sc(ps).current.content_hash });
  check('I: stale → TARGET_CHANGED', st(staleRestore) === 'TARGET_CHANGED');
  check('I: no overwrite on stale restore', (await getContent(stale)) === 'Changed underneath.\n\nPara.');

  // J · a version from another section cannot appear or be restored here
  const other = await mk('Other base.\n\nPara.', 3);
  await applySectionVersion(sb, { book_id: BOOK, section_id: other, expected_content_hash: '', approved_content: 'Other v2.\n\nPara.' });
  const otherVerId = (await listV(other))[0].id;
  const targetIds = new Set((await listV(target)).map((v) => v.id));
  check("J: other section's version not listed under target", !targetIds.has(otherVerId));
  const crossPrev = await previewSectionRestore(sb, { book_id: BOOK, section_id: target, version_id: otherVerId });
  check('J: cross-section preview → VERSION_NOT_FOUND', st(crossPrev) === 'VERSION_NOT_FOUND');
  const crossApply = await applySectionRestore(sb, { book_id: BOOK, section_id: target, version_id: otherVerId, expected_content_hash: '' });
  check('J: cross-section restore → VERSION_NOT_FOUND', st(crossApply) === 'VERSION_NOT_FOUND');
  check('J: target content untouched by cross-section attempt', (await getContent(target)) === V3);

  // Extra · unauthorized list blocked by RLS
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const gl = await listSectionVersions(anon, { book_id: BOOK, section_id: target });
  check('RLS: anon list → NOT_FOUND', st(gl) === 'NOT_FOUND');
} finally {
  await sb.from('books').delete().eq('id', BOOK);
  console.log('\n(fixture cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
