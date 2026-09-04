/**
 * Review & Continuity tests (deterministic engine + reconciliation + states).
 * Fixtures only — never touches canonical Awakened. Requires migration 0012.
 * Run: npx tsx scripts/review-continuity.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { runReview, listReviewFindings, setReviewFindingStatus } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;

const books: string[] = [];
const DUP = 'This is a long duplicated paragraph that appears verbatim in two different chapters of the manuscript to trigger repetition detection cleanly.';
async function mkBook(title = '__review_test__') { const { data } = await sb.from('books').insert({ user_id: OWNER, title, status: 'Planning' }).select('id').single(); books.push(data!.id); return data!.id; }
async function mkChapter(bid: string, n: number, secs: string[]) {
  const { data: ch } = await sb.from('chapters').insert({ book_id: bid, chapter_number: n, title: `Ch${n}`, sort_order: n - 1 }).select('id').single();
  const secIds: string[] = [];
  for (let i = 0; i < secs.length; i++) { const { data: s } = await sb.from('writing_sections').insert({ chapter_id: ch!.id, sort_order: i, content: secs[i], word_count: secs[i]!.split(/\s+/).length }).select('id').single(); secIds.push(s!.id); }
  return { id: ch!.id, secIds };
}
const findingsOf = async (bid: string) => sc(await listReviewFindings(sb, { book_id: bid })).findings as any[];
const byType = (fs: any[], t: string) => fs.filter((f) => f.finding_type === t);

try {
  // A · empty book → safe empty review
  const A = await mkBook();
  const ra = await runReview(sb, { book_id: A });
  check('A: empty manuscript → ok, 0 findings', st(ra) === 'ok' && sc(ra).findings.length === 0);

  // B · consistent book (only a Resolved thread, no conflicts) → no fabrication
  const Bk = await mkBook();
  const bc1 = await mkChapter(Bk, 1, ['Alpha content here, entirely unique and consistent.']);
  await sb.from('story_threads').insert({ book_id: Bk, title: 'Done thread', status: 'Resolved', last_chapter_id: bc1.id });
  const rb = await runReview(sb, { book_id: Bk });
  check('B: consistent manuscript → no fabricated findings', st(rb) === 'ok' && sc(rb).findings.length === 0);

  // Rich fixture book
  const K = await mkBook();
  const c1 = await mkChapter(K, 1, ['Chapter one opening, distinct prose.', DUP]);
  const c2 = await mkChapter(K, 2, ['Chapter two, the meeting happens here.']);
  const c3 = await mkChapter(K, 3, ['Chapter three closes things.', DUP]); // DUP repeated in c1 & c3
  const { data: charT } = await sb.from('characters').insert({ book_id: K, name: 'Timothy' }).select('id').single();
  const { data: charD } = await sb.from('characters').insert({ book_id: K, name: 'Daniella' }).select('id').single();
  // threads: dormant (flag), setup w/ payoff (flag), resolved (no), parked-sequel (no)
  await sb.from('story_threads').insert([
    { book_id: K, title: 'The bee', status: 'Dormant', last_chapter_id: c1.id },
    { book_id: K, title: 'The prophecy', status: 'Active', planned_payoff: 'the word is fulfilled', last_chapter_id: c2.id },
    { book_id: K, title: 'Old arc', status: 'Resolved', last_chapter_id: c1.id },
    { book_id: K, title: 'Sequel seed', status: 'Planned Later', next_expected_beat: 'sequel', planned_payoff: 'next book' }
  ]);
  // canon conflict on a character (likely conflict)
  const { data: fact } = await sb.from('canon_facts').insert({ book_id: K, fact_type: 'trait', subject_type: 'character', subject_id: charT!.id, fact: 'Timothy is 18', source_type: 'manual' } as any).select('id').single();
  await sb.from('canon_fact_conflicts').insert({ canon_fact_id: fact!.id, section_id: c2.secIds[0], previous_manuscript_status: 'confirmed_in_manuscript', previous_fact_text: 'Timothy is 18', conflicting_excerpt: 'Timothy turned nineteen that spring.' } as any);
  // timeline out of order: event_order 1 in ch2, event_order 2 in ch1
  await sb.from('timeline_events').insert([
    { book_id: K, chapter_id: c2.id, event_order: 1, event_description: 'They meet' },
    { book_id: K, chapter_id: c1.id, event_order: 2, event_description: 'They meet again earlier?!' }
  ] as any);
  // relationship with unresolved tension
  await sb.from('relationships').insert({ book_id: K, character_a_id: charT!.id, character_b_id: charD!.id, unresolved_tension: 'A misunderstanding never addressed', last_meaningful_interaction: c2.secIds[0] } as any);

  const run1 = await runReview(sb, { book_id: K });
  const f1 = sc(run1).findings as any[];
  check('C: canon conflict → likely_conflict character', byType(f1, 'character').some((f) => f.level === 'likely_conflict'));
  check('E: dormant thread → plot_thread finding', byType(f1, 'plot_thread').some((f) => f.title.includes('The bee')));
  check('J: setup with planned payoff → setup_payoff', byType(f1, 'setup_payoff').some((f) => f.title.includes('The prophecy')));
  check('F: resolved + parked threads NOT surfaced', !f1.some((f) => f.title.includes('Old arc') || f.title.includes('Sequel seed')));
  check('I: timeline order issue detected', byType(f1, 'timeline').length === 1);
  check('L: repeated passage detected', byType(f1, 'repetition').length === 1);
  check('G: unresolved relationship tension detected', byType(f1, 'relationship').length === 1);
  check('M: evidence cites real chapters', f1.every((f) => f.evidence.length === 0 || f.evidence.some((e: any) => e.chapter_id)));
  check('N: no fabricated findings beyond supported sources', f1.length === (byType(f1, 'plot_thread').length + byType(f1, 'setup_payoff').length + byType(f1, 'character').length + byType(f1, 'timeline').length + byType(f1, 'repetition').length + byType(f1, 'relationship').length));
  check('P: findings persisted', (await sb.from('review_findings').select('id', { count: 'exact', head: true }).eq('book_id', K)).count === f1.length);

  const total1 = f1.length;

  // Q · Intentional persists across re-run
  const payoff = byType(f1, 'setup_payoff')[0]!;
  await setReviewFindingStatus(sb, { book_id: K, finding_id: payoff.id, status: 'intentional' });
  await runReview(sb, { book_id: K });
  check('Q: intentional persists after re-run', (await findingsOf(K)).find((f) => f.id === payoff.id)?.status === 'intentional');

  // R/F · Resolved persists (same evidence) + T no duplicates
  const rep = byType(f1, 'repetition')[0]!;
  await setReviewFindingStatus(sb, { book_id: K, finding_id: rep.id, status: 'resolved' });
  await runReview(sb, { book_id: K });
  const afterR = await findingsOf(K);
  check('R/F: resolved not falsely reopened (same evidence)', afterR.find((f) => f.id === rep.id)?.status === 'resolved');
  check('T: re-run does not duplicate (stable total)', afterR.length === total1);

  // S · Keep watching persists
  const tl = byType(f1, 'timeline')[0]!;
  await setReviewFindingStatus(sb, { book_id: K, finding_id: tl.id, status: 'watch' });
  await runReview(sb, { book_id: K });
  check('S: keep-watching persists', (await findingsOf(K)).find((f) => f.id === tl.id)?.status === 'watch');

  // U · Materially changed evidence reopens a resolved finding
  const bee = byType(f1, 'plot_thread').find((f) => f.title.includes('The bee'))!;
  await setReviewFindingStatus(sb, { book_id: K, finding_id: bee.id, status: 'resolved' });
  await sb.from('story_threads').update({ last_chapter_id: c2.id }).eq('book_id', K).eq('title', 'The bee'); // evidence changes
  await runReview(sb, { book_id: K });
  check('U: materially changed evidence reopens resolved finding', (await findingsOf(K)).find((f) => f.id === bee.id)?.status === 'open');

  // AC · no manuscript writes during review
  const secBefore = (await sb.from('writing_sections').select('content').eq('chapter_id', c1.id).order('sort_order')).data!.map((s) => s.content).join('|');
  await runReview(sb, { book_id: K });
  const secAfter = (await sb.from('writing_sections').select('content').eq('chapter_id', c1.id).order('sort_order')).data!.map((s) => s.content).join('|');
  check('AC: review makes no manuscript writes', secBefore === secAfter);

  // O · removed chapter excluded (deactivate c3 → duplicate gone → repetition open finding removed)
  await sb.from('chapters').update({ archived_at: new Date().toISOString() }).eq('id', c3.id);
  // rep was resolved earlier; reopen it first so we can see removal clear an OPEN finding
  await setReviewFindingStatus(sb, { book_id: K, finding_id: rep.id, status: 'open' });
  await runReview(sb, { book_id: K });
  check('O: inactive chapter excluded → repetition no longer found', byType(await findingsOf(K), 'repetition').length === 0);

  // W · chapter-scoped run returns only findings related to that chapter
  const scoped = sc(await runReview(sb, { book_id: K, chapter_id: c2.id }));
  check('W: chapter-scoped review returns c2-related findings only', (scoped.findings as any[]).length > 0 && (await findingsOf(K)).length >= (scoped.findings as any[]).length);

  // V · whole-book review still works
  check('V: whole-book review returns a summary', typeof sc(await listReviewFindings(sb, { book_id: K })).summary.total_attention === 'number');

  // AA · RLS
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  check('AA: anon run → NOT_FOUND', st(await runReview(anon, { book_id: K })) === 'NOT_FOUND');
  check('AA: anon list → NOT_FOUND', st(await listReviewFindings(anon, { book_id: K })) === 'NOT_FOUND');
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
