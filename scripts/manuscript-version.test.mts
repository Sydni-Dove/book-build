/**
 * Full-book / manuscript version upload tests. Fixtures only — never touches
 * canonical Awakened. Requires migrations 0005–0008. Reuses the tuned parser
 * (parseManuscript) and the chapter-upload section matcher.
 * Run: npx tsx scripts/manuscript-version.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { previewManuscriptVersion, applyManuscriptVersion, listManuscriptVersions } from '../src/lib/mcp/tools.ts';
import { parseManuscript } from '../src/lib/ingest/parseManuscript.ts';

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
  const { data: book } = await sb.from('books').insert({ user_id: OWNER, title: '__ms_test__', status: 'Planning' }).select('id').single();
  const BID = book!.id; books.push(BID);
  for (let i = 0; i < chs.length; i++) {
    const c = chs[i]!;
    const { data: ch } = await sb.from('chapters').insert({ book_id: BID, chapter_number: c.n, title: c.title, sort_order: i }).select('id').single();
    await sb.from('writing_sections').insert(c.secs.map((content, k) => ({ chapter_id: ch!.id, sort_order: k, content, word_count: content.split(/\s+/).length })));
  }
  return BID;
}
const chaptersOf = async (BID: string) => (await sb.from('chapters').select('id, chapter_number, title, sort_order').eq('book_id', BID).order('sort_order')).data ?? [];
const sectionsOf = async (chId: string) => (await sb.from('writing_sections').select('id, sort_order, title, content').eq('chapter_id', chId).order('sort_order')).data ?? [];
const preview = (BID: string, text: string) => previewManuscriptVersion(sb, { book_id: BID, incoming_content: text });
const applyMs = (BID: string, text: string, extra: any = {}) => previewManuscriptVersion(sb, { book_id: BID, incoming_content: text }).then((p) => applyManuscriptVersion(sb, { book_id: BID, incoming_content: text, expected_manuscript_hash: sc(p).manuscript_hash, ...extra }));

const C1: ChSpec = { n: 1, title: 'The Dream', secs: ['The dream opened wide.\n\nDaniella saw the door.', 'A second scene follows.\n\nShe stepped through.'] };
const C2: ChSpec = { n: 2, title: 'The Temptation', secs: ['The temptation grew stronger each day as she waited quietly.'] };
const C3: ChSpec = { n: 3, title: 'The Pursuit', secs: ['She pursued the calling with everything she had left.'] };

try {
  // AA · parser regression — locks the tuned output shape
  const parsed = parseManuscript(ms([C1, C2, C3]));
  check('AA: parser detects 3 chapters, right titles/numbers', parsed.chapters.length === 3 && parsed.chapters[0]!.title === 'The Dream' && parsed.chapters[0]!.chapter_number === 1);
  check('AA: chapter 1 splits into 2 sections on ~~~', parsed.chapters[0]!.sections.length === 2 && parsed.chapters[1]!.sections.length === 1);
  check('AA: front-matter before Chapter 1 ignored', parseManuscript('Front matter blah.\n\nChapter 1: X\n\nBody.').chapters.length === 1);

  // A · identical → UNCHANGED, zero writes
  const A = await buildBook([C1, C2, C3]);
  const pa = await preview(A, ms([C1, C2, C3]));
  check('A: identical → UNCHANGED', st(pa) === 'UNCHANGED');
  const aApply = await applyMs(A, ms([C1, C2, C3]));
  check('A: apply identical → UNCHANGED (no writes)', st(aApply) === 'UNCHANGED' || (st(aApply) === 'applied' && sc(aApply).sections_updated === 0 && sc(aApply).chapters_added === 0));
  check('A: no manuscript snapshot created for identical', ((await sb.from('manuscript_snapshots').select('id', { count: 'exact', head: true }).eq('book_id', A)).count ?? 0) === 0);

  // B · one chapter modified + K modified section + J reuse chapter matcher
  const B = await buildBook([C1, C2, C3]);
  const C2mod: ChSpec = { n: 2, title: 'The Temptation', secs: ['The temptation grew stronger each day as she waited, and then it broke.'] };
  const pb = sc(await preview(B, ms([C1, C2mod, C3])));
  check('B: 1 modified chapter', pb.summary.modified === 1 && pb.summary.unchanged === 2 && pb.summary.new === 0);
  const bChap = pb.chapters.find((c: any) => c.role === 'modified');
  check('J/K: mapped chapter reuses section matcher (1 section modified)', bChap.section_summary.modified === 1);
  const bApply = sc(await applyMs(B, ms([C1, C2mod, C3])));
  check('B: apply updated 1 section', bApply.status === 'applied' && bApply.sections_updated === 1);

  // C · one new chapter
  const C = await buildBook([C1, C2]);
  const C4: ChSpec = { n: 3, title: 'A New Beginning', secs: ['Fresh new chapter content entirely.'] };
  const pc = sc(await preview(C, ms([C1, C2, C4])));
  check('C: 1 new chapter surfaced', pc.summary.new === 1 && pc.chapters.some((x: any) => x.role === 'new'));
  const cApply = sc(await applyMs(C, ms([C1, C2, C4])));
  check('C: apply added 1 chapter', cApply.status === 'applied' && cApply.chapters_added === 1);
  check('C: book now has 3 chapters', (await chaptersOf(C)).length === 3);

  // D/E · chapter absent → KEEP by default; no chapter deletion path exists
  const D = await buildBook([C1, C2, C3]);
  const pd = sc(await preview(D, ms([C1, C2]))); // omit Ch3
  check('D: omitted chapter flagged missing', pd.summary.missing === 1 && pd.chapters.some((x: any) => x.role === 'missing'));
  const dApply = sc(await applyMs(D, ms([C1, C2])));
  // Omission-only upload = nothing to activate (KEEP) → UNCHANGED, and crucially NO chapter deleted.
  check('D/E: omitted chapter KEPT (UNCHANGED, still 3 chapters, none deleted)', (dApply.status === 'UNCHANGED' || dApply.status === 'applied') && (await chaptersOf(D)).length === 3);

  // F · chapter reorder (same titles/content, new order)
  const F = await buildBook([C1, C2, C3]);
  const pf = sc(await preview(F, ms([{ ...C2 }, { ...C1 }, { ...C3 }])));
  check('F: reorder detected', pf.reordered === true && pf.summary.modified === 0 && pf.summary.new === 0);
  const fApply = sc(await applyMs(F, ms([{ ...C2 }, { ...C1 }, { ...C3 }])));
  const fOrder = (await chaptersOf(F)).map((c) => c.title);
  check('F: order now Temptation, Dream, Pursuit', fApply.status === 'applied' && fOrder.join('|') === ['The Temptation', 'The Dream', 'The Pursuit'].join('|'));

  // G · chapter rename (same content, new title) → mapped by content, renamed
  const G = await buildBook([C1, C2, C3]);
  const C1ren: ChSpec = { n: 1, title: 'The Vision', secs: C1.secs };
  const pg = sc(await preview(G, ms([C1ren, C2, C3])));
  const gCard = pg.chapters.find((c: any) => c.renamed);
  check('G: rename detected via content match', !!gCard && gCard.role === 'modified' && gCard.current_title === 'The Dream');

  // H · ambiguous match → needs_review; apply without mapping → NEEDS_RESOLUTION
  const H = await buildBook([{ n: 1, title: 'Alpha', secs: ['alpha beta gamma delta epsilon zeta eta theta'] }, { n: 2, title: 'Omega', secs: ['completely unrelated words here nothing shared whatsoever indeed'] }]);
  const hUpload = ms([{ n: 1, title: 'Mystery', secs: ['alpha beta gamma delta iota kappa lambda mu'] }]);
  const ph = sc(await preview(H, hUpload));
  check('H: ambiguous chapter → needs_review', ph.summary.needs_review === 1 && ph.needs_review_indexes.length === 1);
  const hBlocked = await applyManuscriptVersion(sb, { book_id: H, incoming_content: hUpload, expected_manuscript_hash: ph.manuscript_hash });
  check('H: apply blocked while unresolved → NEEDS_RESOLUTION', st(hBlocked) === 'NEEDS_RESOLUTION');

  // I · manual mapping resolves ambiguity
  const reviewIdx = ph.needs_review_indexes[0];
  const hChapters = await chaptersOf(H);
  const alphaId = hChapters.find((c) => c.title === 'Alpha')!.id;
  const hResolved = sc(await applyManuscriptVersion(sb, { book_id: H, incoming_content: hUpload, expected_manuscript_hash: ph.manuscript_hash, mappings: { [String(reviewIdx)]: alphaId } }));
  check('I: manual mapping resolves + applies', hResolved.status === 'applied');
  check('I: mapped chapter got renamed to uploaded title', (await chaptersOf(H)).find((c) => c.id === alphaId)!.title === 'Mystery');

  // L/M · new section + missing section kept by default (within mapped chapter)
  const L = await buildBook([C1, C2]);
  const C1plus: ChSpec = { n: 1, title: 'The Dream', secs: [C1.secs[0]!, C1.secs[1]!, 'A third brand-new section appears here.'] };
  const pl = sc(await preview(L, ms([C1plus, C2])));
  const lCard = pl.chapters.find((c: any) => c.current_title === 'The Dream');
  check('L: new section detected in mapped chapter', lCard.section_summary.added === 1);
  const C1minus: ChSpec = { n: 1, title: 'The Dream', secs: [C1.secs[0]!] }; // drop 2nd section
  const pm = sc(await preview(L, ms([C1minus, C2])));
  const mCard = pm.chapters.find((c: any) => c.current_title === 'The Dream');
  check('M: missing section surfaced (kept by default)', mCard.section_summary.missing === 1);
  const mApply = sc(await applyMs(L, ms([C1minus, C2]))); // no section_removals → keep
  const ch1L = (await chaptersOf(L)).find((c) => c.title === 'The Dream')!;
  // Keeping the omitted section = no active change → UNCHANGED, and the section survives.
  check('M: missing section KEPT by default (UNCHANGED, 2 sections remain)', (mApply.status === 'UNCHANGED' || mApply.status === 'applied') && (await sectionsOf(ch1L.id)).length === 2);

  // N · explicit section removal + T section history survives removal
  const N = await buildBook([C1, C2]);
  const ch1N = (await chaptersOf(N)).find((c) => c.title === 'The Dream')!;
  const secs1N = await sectionsOf(ch1N.id);
  const dropSecId = secs1N[1]!.id;
  // give that section some history first (before_ai_edit row)
  await sb.from('section_versions').insert({ section_id: dropSecId, content: 'old history for dropped section', version_reason: 'before_ai_edit' });
  const nApply = sc(await applyMs(N, ms([C1minus, C2]), { section_removals: [dropSecId] }));
  check('N: explicit section removal applied', nApply.status === 'applied' && nApply.sections_removed === 1);
  check('N: section gone from active chapter', (await sectionsOf(ch1N.id)).length === 1);
  check('T: removed section history preserved (detached, not destroyed)', ((await sb.from('section_versions').select('id', { count: 'exact', head: true }).eq('detached_section_id', dropSecId)).count ?? 0) === 1);

  // O · section reorder within a mapped chapter
  const O = await buildBook([C1, C2]);
  const C1swap: ChSpec = { n: 1, title: 'The Dream', secs: [C1.secs[1]!, C1.secs[0]!] };
  const oApply = sc(await applyMs(O, ms([C1swap, C2])));
  const ch1O = (await chaptersOf(O)).find((c) => c.title === 'The Dream')!;
  check('O: section reorder applied', oApply.status === 'applied' && (await sectionsOf(ch1O.id)).map((s) => s.content)[0] === C1.secs[1]);

  // P/Q · snapshot contains complete pre-update manuscript with ids/order/titles/content
  const P = await buildBook([C1, C2, C3]);
  const beforeChaps = await chaptersOf(P);
  await applyMs(P, ms([C1, C2mod, C3]));
  const snapRow = (await sb.from('manuscript_snapshots').select('snapshot, chapter_count, section_count, version_reason').eq('book_id', P).order('created_at', { ascending: false }).limit(1)).data![0]!;
  const snap = snapRow.snapshot as any;
  check('P: snapshot reason before_manuscript_upload + counts', snapRow.version_reason === 'before_manuscript_upload' && snapRow.chapter_count === 3);
  check('Q: snapshot has chapter ids/titles/order', snap.chapters.length === 3 && snap.chapters[0].chapter_id === beforeChaps[0]!.id && snap.chapters[0].title === 'The Dream');
  check('Q: snapshot has section ids + ORIGINAL (pre-update) content', snap.chapters[1].sections[0].content === C2.secs[0] && typeof snap.chapters[1].sections[0].section_id === 'string');

  // R · TARGET_CHANGED after preview
  const R = await buildBook([C1, C2, C3]);
  const pr = sc(await preview(R, ms([C1, C2mod, C3])));
  const rCh = (await chaptersOf(R))[0]!;
  await sb.from('writing_sections').update({ content: 'Changed underneath.' }).eq('chapter_id', rCh.id).eq('sort_order', 0);
  const rApply = await applyManuscriptVersion(sb, { book_id: R, incoming_content: ms([C1, C2mod, C3]), expected_manuscript_hash: pr.manuscript_hash });
  check('R: stale apply → TARGET_CHANGED', st(rApply) === 'TARGET_CHANGED');

  // S · transactional failure midway → zero partial + no orphan snapshot
  const S = await buildBook([C1, C2, C3]);
  const sHash = sc(await preview(S, ms([C1, C2, C3]))).manuscript_hash;
  const sChaps = await chaptersOf(S);
  const cvBefore = (await sb.from('manuscript_snapshots').select('id', { count: 'exact', head: true }).eq('book_id', S)).count ?? 0;
  const liveBefore = JSON.stringify(await Promise.all(sChaps.map((c) => sectionsOf(c.id))));
  const { error: sErr } = await sb.rpc('apply_manuscript_version', {
    p_book_id: S, p_expected_hash: sHash, p_source: 'paste', p_source_filename: '',
    p_chapter_updates: [], p_new_chapters: [], p_section_updates: [{ section_id: 'not-a-uuid', content: 'x', word_count: 1 }],
    p_section_inserts: [], p_section_removals: [], p_chapter_reorder: [], p_section_reorder: []
  } as any);
  check('S: bad op aborts transaction', !!sErr);
  check('S: no orphan snapshot (rolled back)', ((await sb.from('manuscript_snapshots').select('id', { count: 'exact', head: true }).eq('book_id', S)).count ?? 0) === cvBefore);
  check('S: no partial manuscript mutation', JSON.stringify(await Promise.all((await chaptersOf(S)).map((c) => sectionsOf(c.id)))) === liveBefore);

  // U · chapter history survives a manuscript update (chapter_versions untouched)
  const U = await buildBook([C1, C2, C3]);
  const uCh = (await chaptersOf(U)).find((c) => c.title === 'The Temptation')!;
  await sb.from('chapter_versions').insert({ chapter_id: uCh.id, book_id: U, version_reason: 'manual_snapshot', chapter_title: 'The Temptation', chapter_hash: 'x', snapshot: { chapter_id: uCh.id, chapter_title: 'The Temptation', chapter_number: 2, captured_hash: 'x', sections: [] } });
  await applyMs(U, ms([C1, C2mod, C3]));
  check('U: chapter_versions preserved through manuscript update', ((await sb.from('chapter_versions').select('id', { count: 'exact', head: true }).eq('chapter_id', uCh.id)).count ?? 0) === 1);

  // V · unauthorized (anon) → NOT_FOUND (RLS)
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const vPrev = await previewManuscriptVersion(anon, { book_id: A, incoming_content: ms([C1]) });
  check('V: anon preview blocked by RLS → NOT_FOUND', st(vPrev) === 'NOT_FOUND');

  // W · wrong book id
  const wPrev = await previewManuscriptVersion(sb, { book_id: '00000000-0000-0000-0000-000000000000', incoming_content: ms([C1]) });
  check('W: unknown book → NOT_FOUND', st(wPrev) === 'NOT_FOUND');

  // Z · large manuscript comparison (perf sanity)
  const bigSpec: ChSpec[] = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, title: `Chapter ${i + 1} Title`, secs: [`Body of chapter ${i + 1} with several words here to count.`] }));
  const Z = await buildBook(bigSpec);
  const t0 = Date.now();
  const pz = sc(await preview(Z, ms(bigSpec)));
  check('Z: large identical manuscript → UNCHANGED under 5s', st({ structuredContent: pz } as any) === 'UNCHANGED' && Date.now() - t0 < 5000);

  // list manuscript versions
  const lv = sc(await listManuscriptVersions(sb, { book_id: P }));
  check('History: manuscript versions listed for a book that had an apply', lv.count >= 1 && typeof lv.current.content_hash === 'string');
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
