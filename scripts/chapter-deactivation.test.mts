/**
 * Safe chapter deactivation / reactivation tests (migration 0010). Fixtures only.
 * Proves deactivation is a pure column update (cascades nothing), current reads
 * exclude inactive chapters, hashes/counts are active-only, and manuscript
 * restore/upload reproduce exact active membership by deactivating/reactivating
 * the SAME chapter identity. Run: npx tsx scripts/chapter-deactivation.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { listChapters, listManuscriptVersions, searchManuscript, previewManuscriptVersion, applyManuscriptVersion, previewManuscriptRestore, applyManuscriptRestore } from '../src/lib/mcp/tools.ts';

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
  const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__ch_deact_test__', status: 'Planning' }).select('id').single();
  const BID = book!.id; books.push(BID);
  for (let i = 0; i < chs.length; i++) { const c = chs[i]!; const { data: ch } = await sb.from('chapters').insert({ book_id: BID, chapter_number: c.n, title: c.title, sort_order: i }).select('id, archived_at').single(); await sb.from('writing_sections').insert(c.secs.map((content, k) => ({ chapter_id: ch!.id, sort_order: k, content, word_count: content.split(/\s+/).length }))); }
  return BID;
}
const chaptersRaw = async (BID: string) => (await sb.from('chapters').select('id, title, sort_order, archived_at').eq('book_id', BID).order('sort_order')).data ?? [];
const activeChapters = async (BID: string) => (await chaptersRaw(BID)).filter((c) => c.archived_at === null);
const sectionsOf = async (chId: string) => (await sb.from('writing_sections').select('id, content').eq('chapter_id', chId).order('sort_order')).data ?? [];
const upload = async (BID: string, text: string, extra: any = {}) => { const p = await previewManuscriptVersion(sb, { book_id: BID, incoming_content: text }); return sc(await applyManuscriptVersion(sb, { book_id: BID, incoming_content: text, expected_manuscript_hash: sc(p).manuscript_hash, ...extra })); };

const C1: ChSpec = { n: 1, title: 'The Dream', secs: ['Dream opens.\n\nA door appears.'] };
const C2: ChSpec = { n: 2, title: 'The Temptation', secs: ['Temptation grows quietly.'] };
const C3: ChSpec = { n: 3, title: 'The Pursuit', secs: ['She pursues zephyrqux the calling.'] }; // unique word for search
const C4: ChSpec = { n: 4, title: 'The Cost', secs: ['A later chapter.'] };

try {
  // A · new chapters are ACTIVE by default (archived_at null)
  const A = await buildBook([C1, C2, C3]);
  check('A: all chapters active by default', (await chaptersRaw(A)).every((c) => c.archived_at === null));

  // Give C3 history + a scene before deactivating
  const c3 = (await chaptersRaw(A)).find((c) => c.title === 'The Pursuit')!;
  const c3sec = (await sectionsOf(c3.id))[0]!;
  await sb.from('section_versions').insert({ section_id: c3sec.id, content: 'old c3 section', version_reason: 'manual_snapshot' });
  await sb.from('chapter_versions').insert({ chapter_id: c3.id, book_id: A, version_reason: 'manual_snapshot', chapter_title: 'The Pursuit', chapter_hash: 'x', snapshot: { chapter_id: c3.id, chapter_title: 'The Pursuit', chapter_number: 3, captured_hash: 'x', sections: [] } });
  await sb.from('scenes').insert({ chapter_id: c3.id, title: 'A scene' });

  // Deactivate C3
  const deact = await sb.rpc('deactivate_chapter', { p_book_id: A, p_chapter_id: c3.id } as any);
  check('deactivate returns deactivated', !deact.error && (deact.data as any).status === 'deactivated');

  // D–J · preservation (deactivation cascades NOTHING)
  const c3row = (await chaptersRaw(A)).find((c) => c.id === c3.id);
  check('D: chapter row preserved with same id + archived_at set', !!c3row && c3row.archived_at !== null);
  check('E: writing_sections preserved', (await sectionsOf(c3.id)).length === 1 && (await sectionsOf(c3.id))[0]!.id === c3sec.id);
  check('F: section_versions preserved', ((await sb.from('section_versions').select('id', { count: 'exact', head: true }).eq('section_id', c3sec.id)).count ?? 0) === 1);
  check('G: chapter_versions preserved', ((await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', c3.id)).count ?? 0) === 1);
  check('H: scenes preserved (still reference the chapter)', ((await sb.from('scenes').select('id', { count: 'exact', head: true }).eq('chapter_id', c3.id)).count ?? 0) === 1);

  // B/K/L/M · current reads + counts exclude inactive
  check('B: listChapters excludes inactive', !sc(await listChapters(sb, { book_id: A })).chapters.some((c: any) => c.id === c3.id) && sc(await listChapters(sb, { book_id: A })).chapters.length === 2);
  const lv = sc(await listManuscriptVersions(sb, { book_id: A }));
  check('K: current chapter count excludes inactive', lv.current.chapters === 2);
  check('L/M: current section + word counts exclude inactive chapter', lv.current.sections === 2 && lv.current.words === (C1.secs.join(' ') + ' ' + C2.secs.join(' ')).split(/\s+/).length);

  // N/O · manuscript_state_hash excludes inactive; TS == SQL
  const sqlHash = (await sb.rpc('manuscript_state_hash', { p_book_id: A } as any)).data as string;
  check('N/O: SQL hash == TS hash (both active-only)', typeof sqlHash === 'string' && sqlHash === lv.current.content_hash);

  // Q · search excludes inactive prose (C3's unique word gone from active search)
  check('Q: search excludes inactive chapter prose', sc(await searchManuscript(sb, { book_id: A, query: 'zephyrqux' })).matches.length === 0);

  // V/W/X/Y · reactivate same identity, no duplication, histories intact
  const react = await sb.rpc('reactivate_chapter', { p_book_id: A, p_chapter_id: c3.id, p_sort_order: 2 } as any);
  check('V: reactivate same chapter_id', !react.error && (react.data as any).chapter_id === c3.id);
  const afterReact = await activeChapters(A);
  check('V: chapter active again (3 active, same id present once)', afterReact.length === 3 && afterReact.filter((c) => c.id === c3.id).length === 1);
  check('W: no duplicate sections', (await sectionsOf(c3.id)).length === 1);
  check('X: section_versions + chapter_versions still intact after reactivate', ((await sb.from('section_versions').select('id', { count: 'exact', head: true }).eq('section_id', c3sec.id)).count ?? 0) === 1 && ((await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', c3.id)).count ?? 0) === 1);
  check('Y: scene still attached after reactivate', ((await sb.from('scenes').select('id', { count: 'exact', head: true }).eq('chapter_id', c3.id)).count ?? 0) === 1);

  // Z/AA/AC · restore integration: exact active membership via deactivate + reactivate
  const R = await buildBook([C1, C2, C3]);
  const up1 = await upload(R, ms([C1, C2, C3, C4])); // snapshot V0 = [C1,C2,C3]; live adds C4
  const V0 = up1.manuscript_snapshot_id;
  const c4 = (await activeChapters(R)).find((c) => c.title === 'The Cost')!;
  const c4sec = (await sectionsOf(c4.id))[0]!;
  const pv0 = sc(await previewManuscriptRestore(sb, { book_id: R, snapshot_id: V0 }));
  check('Z-preview: C4 shows will_remove (not kept)', pv0.summary.will_remove === 1 && pv0.chapters.some((c: any) => c.role === 'will_remove'));
  const r0 = sc(await applyManuscriptRestore(sb, { book_id: R, snapshot_id: V0, expected_manuscript_hash: pv0.manuscript_hash }));
  check('Z: restore deactivated the later chapter', r0.status === 'applied' && r0.chapters_deactivated === 1);
  check('AC: active membership now exactly [C1,C2,C3]', (await activeChapters(R)).map((c) => c.title).join('|') === ['The Dream', 'The Temptation', 'The Pursuit'].join('|'));
  const c4after = (await chaptersRaw(R)).find((c) => c.id === c4.id)!;
  check('Z: C4 row preserved (inactive), same id, sections intact', c4after.archived_at !== null && (await sectionsOf(c4.id)).length === 1 && (await sectionsOf(c4.id))[0]!.id === c4sec.id);

  // AA/AD · restore forward reactivates SAME C4 (inactive row exists → not blocked)
  const VR = sc(await listManuscriptVersions(sb, { book_id: R })).versions[0].version_id; // before_manuscript_restore = [C1,C2,C3,C4]
  const pvR = sc(await previewManuscriptRestore(sb, { book_id: R, snapshot_id: VR }));
  check('AD: snapshot chapter that is inactive → will_reactivate (not blocked)', pvR.can_restore === true && pvR.summary.will_reactivate >= 1);
  const rR = sc(await applyManuscriptRestore(sb, { book_id: R, snapshot_id: VR, expected_manuscript_hash: pvR.manuscript_hash }));
  check('AA: forward restore reactivated SAME C4 id', rR.status === 'applied' && (await activeChapters(R)).some((c) => c.id === c4.id));
  check('AB: no duplicate C4 (exactly one row with that id)', (await chaptersRaw(R)).filter((c) => c.id === c4.id).length === 1);

  // AE · genuinely absent chapter id → blocked
  const E = await buildBook([C1, C2]);
  const hashE = sc(await listManuscriptVersions(sb, { book_id: E })).current.content_hash;
  const { data: ghost } = await sb.from('manuscript_snapshots').insert({ book_id: E, version_reason: 'manual_snapshot', manuscript_hash: hashE, snapshot: { book_id: E, book_title: 'x', manuscript_hash: hashE, chapters: [{ chapter_id: '00000000-0000-0000-0000-000000000000', chapter_number: 9, title: 'Ghost', sort_order: 0, sections: [] }] } } as any).select('id').single();
  check('AE: genuinely absent chapter id → CHAPTER_REACTIVATION_REQUIRED', st(await applyManuscriptRestore(sb, { book_id: E, snapshot_id: ghost!.id, expected_manuscript_hash: hashE })) === 'CHAPTER_REACTIVATION_REQUIRED');

  // AF/AG/AH/AI · upload: missing chapter default KEEP; explicit remove deactivates; reversible
  const U = await buildBook([C1, C2, C3]);
  const upKeep = await upload(U, ms([C1, C2])); // omit C3, no removal → keep
  check('AF: omitted chapter kept by default (still 3 active or UNCHANGED)', (await activeChapters(U)).length === 3);
  const c3u = (await activeChapters(U)).find((c) => c.title === 'The Pursuit')!;
  const upRemove = await upload(U, ms([C1, C2]), { chapter_deactivations: [c3u.id] });
  check('AG: explicit remove deactivates the chapter', upRemove.status === 'applied' && upRemove.chapters_deactivated === 1 && (await activeChapters(U)).length === 2);
  check('AH: upload snapshot created before deactivation', (await sb.from('manuscript_snapshots').select('id', { count: 'exact', head: true }).eq('book_id', U)).count! >= 1);
  // AI: restore the pre-removal snapshot → C3 reactivates
  const preRemoval = sc(await listManuscriptVersions(sb, { book_id: U })).versions.find((v: any) => v.chapter_count === 3);
  const pvAI = sc(await previewManuscriptRestore(sb, { book_id: U, snapshot_id: preRemoval.version_id }));
  await applyManuscriptRestore(sb, { book_id: U, snapshot_id: preRemoval.version_id, expected_manuscript_hash: pvAI.manuscript_hash });
  check('AI: restoring previous version reactivates the removed chapter', (await activeChapters(U)).some((c) => c.id === c3u.id));

  // AJ · a new same-title chapter does NOT hijack the inactive identity
  const J = await buildBook([C1, C3]);
  const c3j = (await activeChapters(J)).find((c) => c.title === 'The Pursuit')!;
  await sb.rpc('deactivate_chapter', { p_book_id: J, p_chapter_id: c3j.id } as any);
  const { data: newSame } = await sb.from('chapters').insert({ book_id: J, chapter_number: 9, title: 'The Pursuit', sort_order: 5 }).select('id').single();
  check('AJ: new same-title chapter has a NEW id; old stays inactive', newSame!.id !== c3j.id && (await chaptersRaw(J)).find((c) => c.id === c3j.id)!.archived_at !== null);

  // AK · RLS: anon cannot deactivate another user's chapter
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const anonDeact = await anon.rpc('deactivate_chapter', { p_book_id: A, p_chapter_id: c3.id } as any);
  check('AK: anon deactivate blocked (NOT_FOUND via RLS)', !!anonDeact.error && /NOT_FOUND/.test(anonDeact.error.message));
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
