/**
 * Removed-chapters recovery surface tests (UI logic over migration 0010).
 * Mirrors what RemovedChapters.tsx does: list archived chapters with word counts,
 * and restore-to-end (reactivate p_sort_order = maxOrder+1) + renumber to max+1
 * so numbering never duplicates. Fixtures only.
 * Run: npx tsx scripts/removed-chapters.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { listManuscriptVersions } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const sc = (r: any) => r.structuredContent as any;

const books: string[] = [];
async function build(chs: { n: number; title: string; secs: string[] }[]) {
  const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__removed_ch_test__', status: 'Planning' }).select('id').single();
  const BID = book!.id; books.push(BID);
  for (let i = 0; i < chs.length; i++) { const c = chs[i]!; const { data: ch } = await sb.from('chapters').insert({ book_id: BID, chapter_number: c.n, title: c.title, sort_order: i }).select('id').single(); await sb.from('writing_sections').insert(c.secs.map((content, k) => ({ chapter_id: ch!.id, sort_order: k, content, word_count: content.split(/\s+/).length }))); }
  return BID;
}
const raw = async (BID: string) => (await sb.from('chapters').select('id, title, chapter_number, sort_order, archived_at').eq('book_id', BID).order('sort_order')).data ?? [];
const activeCh = async (BID: string) => (await raw(BID)).filter((c) => c.archived_at === null);
// Mirror of RemovedChapters.tsx list query.
const removedList = async (BID: string) => (await sb.from('chapters').select('id, title, chapter_number, archived_at').eq('book_id', BID).not('archived_at', 'is', null).order('archived_at', { ascending: false })).data ?? [];
const sectionsOf = async (chId: string) => (await sb.from('writing_sections').select('id, content, word_count').eq('chapter_id', chId)).data ?? [];
// Atomic restore-to-end (RemovedChapters.tsx now calls this one RPC).
async function restore(BID: string, id: string) {
  return sb.rpc('reactivate_chapter_to_end', { p_book_id: BID, p_chapter_id: id } as any);
}

try {
  // A · no removed chapters → nothing listed
  const A = await build([{ n: 1, title: 'One', secs: ['a a a'] }, { n: 2, title: 'Two', secs: ['b b'] }]);
  check('A: no removed chapters', (await removedList(A)).length === 0);

  // Deactivate the MIDDLE chapter of a 3-chapter book
  const B = await build([{ n: 1, title: 'One', secs: ['alpha beta'] }, { n: 2, title: 'Two', secs: ['gamma delta epsilon', 'zeta'] }, { n: 3, title: 'Three', secs: ['eta'] }]);
  const mid = (await activeCh(B)).find((c) => c.title === 'Two')!;
  const midSecs = await sectionsOf(mid.id);
  await sb.rpc('deactivate_chapter', { p_book_id: B, p_chapter_id: mid.id } as any);

  // B/C/D/E · removed list content
  const rem = await removedList(B);
  check('B: removed chapter listed + excluded from active', rem.length === 1 && rem[0]!.id === mid.id && (await activeCh(B)).every((c) => c.id !== mid.id));
  check('C: correct title', rem[0]!.title === 'Two');
  const remWords = midSecs.reduce((n, s) => n + (s.word_count ?? 0), 0);
  check('D: word count computed from its sections', remWords === 4);
  check('E: removal timestamp present (archived_at)', !!rem[0]!.archived_at);

  // F–J · identity + data preserved while removed
  check('F/G: same id + sections preserved', (await sectionsOf(mid.id)).length === 2 && (await sectionsOf(mid.id)).map((s) => s.id).sort().join() === midSecs.map((s) => s.id).sort().join());

  // H · atomicity guards BEFORE the real restore: wrong book / already-active
  const wrongBook = await sb.rpc('reactivate_chapter_to_end', { p_book_id: '00000000-0000-0000-0000-000000000000', p_chapter_id: mid.id } as any);
  check('H/J: wrong book → error, chapter stays removed', !!wrongBook.error && (await raw(B)).find((c) => c.id === mid.id)!.archived_at !== null);

  // Restore to end + renumber — ONE atomic RPC, server-computed position
  const preActive = await activeCh(B);
  const expectOrder = preActive.reduce((m, c) => Math.max(m, c.sort_order), -1) + 1;
  const expectNum = preActive.reduce((m, c) => Math.max(m, c.chapter_number ?? 0), 0) + 1;
  const rres = await restore(B, mid.id);
  check('A/F: restore applied (reactivated)', !rres.error && (rres.data as any).status === 'reactivated');
  const afterAct = await activeCh(B);
  const restored = afterAct.find((c) => c.id === mid.id)!;
  check('F: restored → same chapter_id, active again', !!restored && (await removedList(B)).length === 0);
  check('C: restored chapter is last by sort_order', afterAct[afterAct.length - 1]!.id === mid.id);
  check('D: chapter_number = next active number (server-computed)', restored.chapter_number === expectNum);
  check('E: sort_order = next active order (server-computed)', restored.sort_order === expectOrder);
  const nums = afterAct.map((c) => c.chapter_number);
  check('F-dup: no duplicate chapter_number after restore', new Set(nums).size === nums.length);
  check('G-dup: no duplicate sort_order after restore', new Set(afterAct.map((c) => c.sort_order)).size === afterAct.length);
  check('T: no duplicate chapter row', (await raw(B)).filter((c) => c.id === mid.id).length === 1);
  check('G: sections not duplicated on restore', (await sectionsOf(mid.id)).length === 2);

  // K · already-active → rejected, no change
  const already = await sb.rpc('reactivate_chapter_to_end', { p_book_id: B, p_chapter_id: mid.id } as any);
  check('K: already-active restore rejected (ALREADY_ACTIVE)', !!already.error && /ALREADY_ACTIVE/.test(already.error.message));
  check('K: no change from rejected re-restore', (await activeCh(B)).filter((c) => c.id === mid.id).length === 1);

  // K/L/M · current counts reflect restored chapter
  const lv = sc(await listManuscriptVersions(sb, { book_id: B }));
  check('K/L: current counts include restored chapter (3 chapters)', lv.current.chapters === 3);
  check('M: manuscript hash is defined + active-based', typeof lv.current.content_hash === 'string' && lv.current.content_hash.length > 0);

  // P/Q/R · Add Chapter creates a NEW id; does NOT reactivate a same-title removed chapter
  const C = await build([{ n: 1, title: 'Keep', secs: ['x'] }, { n: 2, title: 'Gone', secs: ['y'] }]);
  const gone = (await activeCh(C)).find((c) => c.title === 'Gone')!;
  await sb.rpc('deactivate_chapter', { p_book_id: C, p_chapter_id: gone.id } as any);
  // Add Chapter with the SAME title as the removed one (mirrors addChapter() → RPC)
  const addRes = await sb.rpc('add_chapter_at_end', { p_book_id: C, p_title: 'Gone' } as any);
  const addedId = (addRes.data as any).chapter_id as string;
  const added = (await raw(C)).find((c) => c.id === addedId)!;
  check('P: Add Chapter creates a NEW id (via add_chapter_at_end)', addedId !== gone.id);
  check('Q: Add Chapter is active + server-numbered at end', added.archived_at === null && (addRes.data as any).chapter_number === 2);
  check('R: same-title add does NOT reactivate the removed chapter', (await raw(C)).find((c) => c.id === gone.id)!.archived_at !== null);

  // U · repeated remove/restore cycles stable
  const U = await build([{ n: 1, title: 'A', secs: ['one'] }, { n: 2, title: 'B', secs: ['two'] }]);
  const b2 = (await activeCh(U)).find((c) => c.title === 'B')!;
  for (let i = 0; i < 3; i++) { await sb.rpc('deactivate_chapter', { p_book_id: U, p_chapter_id: b2.id } as any); await restore(U, b2.id); }
  check('U: repeated cycles keep exactly one active row + its sections', (await raw(U)).filter((c) => c.id === b2.id).length === 1 && (await sectionsOf(b2.id)).length === 1 && (await activeCh(U)).some((c) => c.id === b2.id));

  // V · RLS — anon cannot restore another user's removed chapter
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  await sb.rpc('deactivate_chapter', { p_book_id: B, p_chapter_id: mid.id } as any);
  const anonRestore = await anon.rpc('reactivate_chapter_to_end', { p_book_id: B, p_chapter_id: mid.id } as any);
  check('V: anon restore blocked by RLS', !!anonRestore.error);
  check('V: chapter still removed after blocked anon restore', (await raw(B)).find((c) => c.id === mid.id)!.archived_at !== null);
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
