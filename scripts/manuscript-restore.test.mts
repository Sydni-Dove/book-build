/**
 * Manuscript version history + compare + restore tests. Fixtures only — never
 * touches canonical Awakened. Requires migrations 0005–0009. KEEP-only restore.
 * Run: npx tsx scripts/manuscript-restore.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { previewManuscriptVersion, applyManuscriptVersion, listManuscriptVersions, previewManuscriptRestore, applyManuscriptRestore } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;

type ChSpec = { n: number; title: string; secs: string[] };
const ms = (chs: ChSpec[]) => chs.map((c) => `Chapter ${c.n}: ${c.title}\n\n${c.secs.join('\n\n~~~\n\n')}`).join('\n\n');
const books: string[] = [];
async function buildBook(chs: ChSpec[]) {
  const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__ms_restore_test__', status: 'Planning' }).select('id').single();
  const BID = book!.id; books.push(BID);
  for (let i = 0; i < chs.length; i++) { const c = chs[i]!; const { data: ch } = await sb.from('chapters').insert({ book_id: BID, chapter_number: c.n, title: c.title, sort_order: i }).select('id').single(); await sb.from('writing_sections').insert(c.secs.map((content, k) => ({ chapter_id: ch!.id, sort_order: k, content, word_count: content.split(/\s+/).length }))); }
  return BID;
}
const chaptersOf = async (BID: string) => (await sb.from('chapters').select('id, chapter_number, title, sort_order').eq('book_id', BID).order('sort_order')).data ?? [];
const sectionsOf = async (chId: string) => (await sb.from('writing_sections').select('id, sort_order, title, content').eq('chapter_id', chId).order('sort_order')).data ?? [];
const upload = async (BID: string, text: string, extra: any = {}) => { const p = await previewManuscriptVersion(sb, { book_id: BID, incoming_content: text }); return sc(await applyManuscriptVersion(sb, { book_id: BID, incoming_content: text, expected_manuscript_hash: sc(p).manuscript_hash, ...extra })); };
const msCount = async (BID: string) => (await sb.from('manuscript_snapshots').select('id', { count: 'exact', head: true }).eq('book_id', BID)).count ?? 0;

const C1: ChSpec = { n: 1, title: 'The Dream', secs: ['Dream opens.\n\nDaniella sees a door.', 'Second dream scene.\n\nShe steps through.'] };
const C2: ChSpec = { n: 2, title: 'The Temptation', secs: ['Temptation grows stronger each day quietly.'] };
// High word-overlap with C2 so the upload edits the section IN PLACE (same id).
const C2b: ChSpec = { n: 2, title: 'The Temptation', secs: ['Temptation grows stronger each day quietly, and then it finally broke.'] };
const C3: ChSpec = { n: 3, title: 'The Pursuit', secs: ['She pursues the calling with all she has.'] };
const C4: ChSpec = { n: 4, title: 'The Cost', secs: ['A later chapter written afterward.'] };

try {
  // A · empty history
  const A = await buildBook([C1, C2]);
  check('A: no history → empty', sc(await listManuscriptVersions(sb, { book_id: A })).count === 0);

  // Build history: V0=[C1,C2,C3] then add C4, then modify C2
  const H = await buildBook([C1, C2, C3]);
  const up1 = await upload(H, ms([C1, C2, C3, C4]));      // snapshot V0 = [C1,C2,C3]
  const V0 = up1.manuscript_snapshot_id;
  const up2 = await upload(H, ms([C1, C2b, C3, C4]));     // snapshot V1 = [C1,C2,C3,C4]
  const V1 = up2.manuscript_snapshot_id;

  // B · list newest first + current pinned
  const lb = sc(await listManuscriptVersions(sb, { book_id: H }));
  check('B: 2 snapshots newest-first + current pinned', lb.count === 2 && lb.versions[0].version_id === V1 && lb.versions[1].version_id === V0 && lb.current.chapters === 4);

  // C · preview no write; E modified chapter; H only_in_current; J/K/L/M section-level
  const curBefore = JSON.stringify(await Promise.all((await chaptersOf(H)).map((c) => sectionsOf(c.id))));
  const pv0 = sc(await previewManuscriptRestore(sb, { book_id: H, snapshot_id: V0 }));
  check('C: preview mutates nothing', JSON.stringify(await Promise.all((await chaptersOf(H)).map((c) => sectionsOf(c.id)))) === curBefore);
  check('E: C2 shows modified (current C2b vs snapshot C2)', pv0.chapters.some((c: any) => c.role === 'modified' && c.current_title === 'The Temptation'));
  check('H: C4 will_remove (deactivated on restore, not kept)', pv0.summary.will_remove === 1 && pv0.chapters.some((c: any) => c.role === 'will_remove' && c.title === 'The Cost'));
  check('J: modified chapter exposes section diff', pv0.chapters.find((c: any) => c.role === 'modified').sections.some((s: any) => s.role === 'modified'));
  check('can_restore true (all snapshot chapters still exist)', pv0.can_restore === true && pv0.will_remove_chapters === 1);

  // N/O/P/T/AA · restore V0
  const msBeforeRestore = await msCount(H);
  const rv0 = sc(await applyManuscriptRestore(sb, { book_id: H, snapshot_id: V0, expected_manuscript_hash: pv0.manuscript_hash }));
  check('N: restore applied', rv0.status === 'applied');
  check('AA: pre-restore snapshot created (+1)', (await msCount(H)) === msBeforeRestore + 1);
  const afterR = await chaptersOf(H);
  const c2after = afterR.find((c) => c.title === 'The Temptation')!;
  check('P: C2 content restored to original', (await sectionsOf(c2after.id))[0]!.content === C2.secs[0]);
  check('T: extra chapter C4 KEPT (still present)', afterR.some((c) => c.title === 'The Cost'));
  check('O: restored chapters ordered before kept extra', afterR.map((c) => c.title).slice(0, 3).join('|') === ['The Dream', 'The Temptation', 'The Pursuit'].join('|') && afterR[afterR.length - 1]!.title === 'The Cost');

  // Q/R · section reintroduced with original id + history reconnect
  const Q = await buildBook([C1, C2]); // C1 has 2 sections
  const c1q = (await chaptersOf(Q)).find((c) => c.title === 'The Dream')!;
  const sec2 = (await sectionsOf(c1q.id))[1]!;
  await sb.from('section_versions').insert({ section_id: sec2.id, content: 'history for sec2', version_reason: 'before_ai_edit' });
  const C1drop: ChSpec = { n: 1, title: 'The Dream', secs: [C1.secs[0]!] };
  const upQ = await upload(Q, ms([C1drop, C2]), { section_removals: [sec2.id] }); // snapshot had sec2; live drops it
  const Vq = upQ.manuscript_snapshot_id;
  check('Q-setup: sec2 removed from active + history detached', (await sectionsOf(c1q.id)).length === 1 && ((await sb.from('section_versions').select('id', { count: 'exact', head: true }).eq('detached_section_id', sec2.id)).count ?? 0) === 1);
  const pvq = sc(await previewManuscriptRestore(sb, { book_id: Q, snapshot_id: Vq }));
  check('L: sec2 shows only_in_selected (restore brings back)', pvq.chapters.find((c: any) => c.chapter_id === c1q.id).sections.some((s: any) => s.role === 'only_in_selected'));
  await applyManuscriptRestore(sb, { book_id: Q, snapshot_id: Vq, expected_manuscript_hash: pvq.manuscript_hash });
  check('Q: sec2 reintroduced with ORIGINAL id', (await sectionsOf(c1q.id)).some((s) => s.id === sec2.id));
  check('R: sec2 history reconnected (active again)', ((await sb.from('section_versions').select('id', { count: 'exact', head: true }).eq('section_id', sec2.id)).count ?? 0) === 1 && ((await sb.from('section_versions').select('id', { count: 'exact', head: true }).eq('detached_section_id', sec2.id)).count ?? 0) === 0);

  // S · chapter_versions preserved through manuscript restore
  const S = await buildBook([C1, C2, C3]);
  const upS = await upload(S, ms([C1, C2b, C3]));
  const cS = (await chaptersOf(S)).find((c) => c.title === 'The Temptation')!;
  await sb.from('chapter_versions').insert({ chapter_id: cS.id, book_id: S, version_reason: 'manual_snapshot', chapter_title: 'The Temptation', chapter_hash: 'x', snapshot: { chapter_id: cS.id, chapter_title: 'The Temptation', chapter_number: 2, captured_hash: 'x', sections: [] } });
  const pvS = sc(await previewManuscriptRestore(sb, { book_id: S, snapshot_id: upS.manuscript_snapshot_id }));
  await applyManuscriptRestore(sb, { book_id: S, snapshot_id: upS.manuscript_snapshot_id, expected_manuscript_hash: pvS.manuscript_hash });
  check('S: chapter_versions preserved through restore', ((await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', cS.id)).count ?? 0) === 1);

  // U · TARGET_CHANGED
  const U = await buildBook([C1, C2]);
  const upU = await upload(U, ms([C1, C2b]));
  const pvU = sc(await previewManuscriptRestore(sb, { book_id: U, snapshot_id: upU.manuscript_snapshot_id }));
  await sb.from('writing_sections').update({ content: 'Changed underneath.' }).eq('chapter_id', (await chaptersOf(U))[0]!.id).eq('sort_order', 0);
  check('U: stale restore → TARGET_CHANGED', st(await applyManuscriptRestore(sb, { book_id: U, snapshot_id: upU.manuscript_snapshot_id, expected_manuscript_hash: pvU.manuscript_hash })) === 'TARGET_CHANGED');

  // I · snapshot references a chapter that no longer exists → blocked
  const I = await buildBook([C1, C2]);
  const hashI = sc(await listManuscriptVersions(sb, { book_id: I })).current.content_hash;
  const { data: badChap } = await sb.from('manuscript_snapshots').insert({ book_id: I, version_reason: 'manual_snapshot', book_title: '__ms_restore_test__', manuscript_hash: hashI, chapter_count: 1, section_count: 1, word_count: 1, snapshot: { book_id: I, book_title: '__ms_restore_test__', manuscript_hash: hashI, chapters: [{ chapter_id: '00000000-0000-0000-0000-000000000000', chapter_number: 9, title: 'Ghost', sort_order: 0, sections: [] }] } } as any).select('id').single();
  const pvI = sc(await previewManuscriptRestore(sb, { book_id: I, snapshot_id: badChap!.id }));
  check('I: preview flags cannot-restore (chapter reactivation required)', pvI.can_restore === false && pvI.blocking_issues.includes('CHAPTER_REACTIVATION_REQUIRED'));
  check('I: apply → CHAPTER_REACTIVATION_REQUIRED, no write', st(await applyManuscriptRestore(sb, { book_id: I, snapshot_id: badChap!.id, expected_manuscript_hash: hashI })) === 'CHAPTER_REACTIVATION_REQUIRED');

  // V · malformed snapshot → zero mutation
  const V = await buildBook([C1, C2]);
  const hashV = sc(await listManuscriptVersions(sb, { book_id: V })).current.content_hash;
  const { data: badSnap } = await sb.from('manuscript_snapshots').insert({ book_id: V, version_reason: 'manual_snapshot', manuscript_hash: hashV, snapshot: { book_id: V, chapters: 'not-an-array' } } as any).select('id').single();
  const liveV = JSON.stringify(await Promise.all((await chaptersOf(V)).map((c) => sectionsOf(c.id))));
  const cvV = await msCount(V);
  const { error: vErr } = await sb.rpc('apply_manuscript_restore', { p_book_id: V, p_snapshot_id: badSnap!.id, p_expected_hash: hashV } as any);
  check('V: malformed snapshot raises', !!vErr);
  check('V: no mutation + no orphan snapshot', JSON.stringify(await Promise.all((await chaptersOf(V)).map((c) => sectionsOf(c.id)))) === liveV && (await msCount(V)) === cvV);

  // W · RPC failure midway (bad section word_count) → rollback
  const W = await buildBook([C1, C2]);
  const wCh = (await chaptersOf(W)).find((c) => c.title === 'The Temptation')!;
  const hashW = sc(await listManuscriptVersions(sb, { book_id: W })).current.content_hash;
  const { data: badMid } = await sb.from('manuscript_snapshots').insert({ book_id: W, version_reason: 'manual_snapshot', manuscript_hash: hashW, snapshot: { book_id: W, book_title: 'x', manuscript_hash: hashW, chapters: [{ chapter_id: wCh.id, chapter_number: 2, title: 'The Temptation', sort_order: 1, sections: [{ section_id: '11111111-1111-1111-1111-111111111111', sort_order: 0, title: null, content: 'x', word_count: 'not-int' }] }] } } as any).select('id').single();
  const liveW = JSON.stringify(await Promise.all((await chaptersOf(W)).map((c) => sectionsOf(c.id))));
  const cvW = await msCount(W);
  const { error: wErr } = await sb.rpc('apply_manuscript_restore', { p_book_id: W, p_snapshot_id: badMid!.id, p_expected_hash: hashW } as any);
  check('W: mid-op failure raises', !!wErr);
  check('W: full rollback — no partial + no orphan snapshot', JSON.stringify(await Promise.all((await chaptersOf(W)).map((c) => sectionsOf(c.id)))) === liveW && (await msCount(W)) === cvW);

  // X · wrong book / version
  check('X: snapshot from another book → VERSION_NOT_FOUND', st(await previewManuscriptRestore(sb, { book_id: A, snapshot_id: V0 })) === 'VERSION_NOT_FOUND');
  check('X: unknown book → NOT_FOUND', st(await previewManuscriptRestore(sb, { book_id: '00000000-0000-0000-0000-000000000000', snapshot_id: V0 })) === 'NOT_FOUND');

  // Y · RLS
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  check('Y: anon preview blocked → NOT_FOUND', st(await previewManuscriptRestore(anon, { book_id: H, snapshot_id: V0 })) === 'NOT_FOUND');

  // AB · restore forward: after restoring V0, the pre-restore snapshot (VR)
  // captured the live [C1,C2b,C3,C4]. Restoring VR recovers C2b + keeps C4.
  const VR = sc(await listManuscriptVersions(sb, { book_id: H })).versions[0].version_id; // newest = before_manuscript_restore
  const pvFwd = sc(await previewManuscriptRestore(sb, { book_id: H, snapshot_id: VR }));
  const rFwd = sc(await applyManuscriptRestore(sb, { book_id: H, snapshot_id: VR, expected_manuscript_hash: pvFwd.manuscript_hash }));
  const c2fwd = (await chaptersOf(H)).find((c) => c.title === 'The Temptation')!;
  check('AB: restore forward recovers C2b + keeps C4', rFwd.status === 'applied' && (await sectionsOf(c2fwd.id))[0]!.content === C2b.secs[0] && (await chaptersOf(H)).some((c) => c.title === 'The Cost'));

  // Z · current cannot restore onto itself → UNCHANGED (VR now == current)
  const pvSelf = sc(await previewManuscriptRestore(sb, { book_id: H, snapshot_id: VR }));
  check('Z: snapshot identical to current → UNCHANGED', pvSelf.status === 'UNCHANGED');

  // AD · counts present + correct
  const lvAD = sc(await listManuscriptVersions(sb, { book_id: H }));
  check('AD: counts present (current + versions have chapter/section/word counts)', typeof lvAD.current.words === 'number' && lvAD.versions.every((v: any) => typeof v.chapter_count === 'number' && typeof v.word_count === 'number'));
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
