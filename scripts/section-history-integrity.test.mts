/**
 * Section-history preservation integrity tests (migration 0007). Fixtures only.
 * Proves that removing a section from the active chapter — via chapter upload
 * removal OR chapter restore — DETACHES its section_versions history instead of
 * destroying it, and that restoring the section (same id) RECONNECTS that
 * history. Run: npx tsx scripts/section-history-integrity.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import {
  previewSectionVersion, applySectionVersion, listSectionVersions,
  previewChapterVersion, applyChapterVersion,
  previewChapterRestore, applyChapterRestore
} from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;

const cA = 'Section A content.\n\nAlpha stays put.';
const cB = 'Section B content.\n\nBeta stays put.';
const cC = 'Section C original.\n\nGamma begins.';
const cC2 = 'Section C revised once.\n\nGamma continues.';
const cC3 = 'Section C revised twice.\n\nGamma resolves.';
const join = (...xs: string[]) => xs.join('\n\n~~~\n\n');

const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__section_history_integrity__', status: 'Planning' }).select('id').single();
const BOOK = book!.id;
const { data: chap } = await sb.from('chapters').insert({ book_id: BOOK, chapter_number: 1, title: 'Ch1', sort_order: 1 }).select('id').single();
const CH = chap!.id;
const mk = async (content: string, order: number) => (await sb.from('writing_sections').insert({ chapter_id: CH, sort_order: order, content, word_count: content.split(/\s+/).length }).select('id').single()).data!.id;
const secsOf = async () => (await sb.from('writing_sections').select('id, content').eq('chapter_id', CH).order('sort_order')).data ?? [];
const historyRows = async (sectionId: string) => (await sb.from('section_versions').select('id, section_id, version_reason, created_at, detached_section_id').eq('detached_section_id', sectionId)).data ?? [];
const activeHistoryRows = async (sectionId: string) => (await sb.from('section_versions').select('id, section_id, version_reason, created_at').eq('section_id', sectionId)).data ?? [];
const upSection = async (sectionId: string, next: string) => {
  const p = await previewSectionVersion(sb, { book_id: BOOK, chapter_id: CH, section_id: sectionId, incoming_content: next });
  return applySectionVersion(sb, { book_id: BOOK, chapter_id: CH, section_id: sectionId, expected_content_hash: sc(p).current.content_hash, approved_content: next });
};

try {
  const A = await mk(cA, 0);
  const B = await mk(cB, 1);
  const C = await mk(cC, 2);

  // Give C real section-upload history (2 manual_snapshot rows) …
  await upSection(C, cC2);
  await upSection(C, cC3);
  // … plus a paragraph-revision-style snapshot (before_ai_edit) — same table/row
  // the apply_paragraph_revision path writes.
  await sb.from('section_versions').insert({ section_id: C, content: 'C paragraph pre-edit.', version_reason: 'before_ai_edit' });
  const cHistBefore = await activeHistoryRows(C);
  check('setup: C has 3 section_versions (2 manual_snapshot + 1 before_ai_edit)', cHistBefore.length === 3 && cHistBefore.filter((r) => r.version_reason === 'manual_snapshot').length === 2 && cHistBefore.some((r) => r.version_reason === 'before_ai_edit'));
  const histIds = cHistBefore.map((r) => r.id).sort();
  const histCreatedAt = cHistBefore.map((r) => r.created_at).sort();

  // D · CHAPTER UPLOAD explicit removal → C leaves active chapter
  const up = sc(await (async () => { const p = await previewChapterVersion(sb, { book_id: BOOK, chapter_id: CH, incoming_content: join(cA, cB) }); return applyChapterVersion(sb, { book_id: BOOK, chapter_id: CH, incoming_content: join(cA, cB), expected_chapter_hash: sc(p).chapter_hash, removals: [C] }); })());
  const V_withC = up.chapter_version_id; // snapshot BEFORE removal → contains C(cC3)
  check('D: C removed from active chapter (upload removal)', (await secsOf()).every((s) => s.id !== C) && (await secsOf()).length === 2);
  check('J: active chapter query does not render the removed section', (await secsOf()).map((s) => s.content).join('|') === [cA, cB].join('|'));

  // A · its section_versions SURVIVE (detached), with timestamps + reasons intact
  const detached = await historyRows(C);
  check('A: C history preserved (3 rows) after removal', detached.length === 3);
  check('A: detached rows have section_id NULL + detached_section_id=C', detached.every((r) => r.section_id === null && r.detached_section_id === C));
  check('A: reasons + timestamps intact', detached.map((r) => r.id).sort().join() === histIds.join() && detached.map((r) => r.created_at).sort().join() === histCreatedAt.join());

  // H · detached history is invisible to a normal (anon/RLS) client while inactive
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const anonSees = (await anon.from('section_versions').select('id').eq('detached_section_id', C)).data ?? [];
  check('H: RLS blocks access to detached history', anonSees.length === 0);

  // B · RESTORE FORWARD to the version containing C → C returns w/ SAME id + history reconnects
  const pr = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: V_withC }));
  check('E-preview: removed C shows as only-in-selected (restoring brings it back)', pr.sections.some((s: any) => s.role === 'only_in_selected' && s.section_id === C));
  await applyChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: V_withC, expected_chapter_hash: pr.chapter_hash });
  const afterRestore = await secsOf();
  check('B: C reactivated with the SAME id', afterRestore.some((s) => s.id === C && s.content === cC3));
  const reconnected = await activeHistoryRows(C);
  check('B/L: C history reconnected (3 rows, section_id=C again)', reconnected.length === 3 && reconnected.map((r) => r.id).sort().join() === histIds.join());
  check('B: no rows left detached for C', (await historyRows(C)).length === 0);
  check('F+G: both manual_snapshot (upload) and before_ai_edit (paragraph) history survived', reconnected.filter((r) => r.version_reason === 'manual_snapshot').length === 2 && reconnected.some((r) => r.version_reason === 'before_ai_edit'));

  // Section Version History tool works normally again after restore
  const lv = sc(await listSectionVersions(sb, { book_id: BOOK, section_id: C }));
  check('L: Section Version History lists C\'s versions after restore', lv.count === 3);

  // E · CHAPTER RESTORE removal path: restore to the pre-restore [A,B] snapshot → drops C again
  const abSnap = (await sb.from('chapter_versions').select('id, snapshot').eq('chapter_id', CH).order('created_at', { ascending: false }).limit(1)).data![0]!; // before_chapter_restore = [A,B]
  const pr2 = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: abSnap.id }));
  await applyChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: abSnap.id, expected_chapter_hash: pr2.chapter_hash });
  check('E: chapter-restore removal drops C from active chapter', (await secsOf()).every((s) => s.id !== C));
  check('E: C history preserved again via restore-removal (detached, 3 rows)', (await historyRows(C)).length === 3);

  // C · repeated remove/restore cycle keeps exactly the same 3 rows
  const pr3 = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: V_withC }));
  await applyChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: V_withC, expected_chapter_hash: pr3.chapter_hash });
  const afterCycle = await activeHistoryRows(C);
  check('C: after remove→restore cycles, same 3 history rows, same ids', afterCycle.length === 3 && afterCycle.map((r) => r.id).sort().join() === histIds.join());

  // I · rollback: a failing restore must not leave partial detach/reconnect state
  const hashNow = await listChapterVersionsHash(CH);
  const { data: badRow } = await sb.from('chapter_versions').insert({
    chapter_id: CH, book_id: BOOK, version_reason: 'manual_snapshot', chapter_title: 'Ch1', chapter_hash: hashNow,
    snapshot: { chapter_id: CH, chapter_title: 'Ch1', chapter_number: 1, captured_hash: hashNow, sections: [{ section_id: 'not-a-uuid', sort_order: 0, title: null, content: 'x', word_count: 1 }] }
  } as any).select('id').single();
  const liveBefore = (await secsOf()).map((s) => s.content).join('|');
  const cvBefore = (await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', CH)).count ?? 0;
  const { error: badErr } = await sb.rpc('apply_chapter_restore', { p_book_id: BOOK, p_chapter_id: CH, p_expected_hash: hashNow, p_version_id: badRow!.id } as any);
  check('I: malformed restore raises (rolls back)', !!badErr);
  check('I: no partial — C history unchanged (3 active, 0 detached)', (await activeHistoryRows(C)).length === 3 && (await historyRows(C)).length === 0);
  check('I: no partial — live chapter + snapshot count unchanged', (await secsOf()).map((s) => s.content).join('|') === liveBefore && ((await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', CH)).count ?? 0) === cvBefore);

  // K · stale protection still correct on the (now C-containing) chapter
  const pk = sc(await previewChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: V_withC }));
  await sb.from('writing_sections').update({ content: 'Changed underneath.' }).eq('id', A);
  const kr = await applyChapterRestore(sb, { book_id: BOOK, chapter_id: CH, version_id: V_withC, expected_chapter_hash: pk.chapter_hash });
  check('K: chapter hash/stale protection still behaves (TARGET_CHANGED)', st(kr) === 'TARGET_CHANGED');
} finally {
  await sb.from('books').delete().eq('id', BOOK);
  console.log('\n(fixture cleaned up)');
}

// tiny helper to read the current chapter hash without importing internals
async function listChapterVersionsHash(chapterId: string) {
  const { listChapterVersions } = await import('../src/lib/mcp/tools.ts');
  const r = await listChapterVersions(sb, { book_id: BOOK, chapter_id: chapterId });
  return (r.structuredContent as any).current.content_hash;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
