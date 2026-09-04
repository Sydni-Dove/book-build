/**
 * Deep (AI) Review pass tests. Uses an INJECTED candidate generator so the
 * evidence-verification, dedup, reconciliation, hash-gate, and failure handling
 * are tested deterministically — no real OpenAI calls. Fixtures only.
 * Run: npx tsx scripts/review-deep.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { runDeepReview, proposeCanonFromFinding, listReviewFindings } from '../src/lib/mcp/tools.ts';
import type { RawAiResult } from '../src/lib/ai/review/deepReview.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });

let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const st = (r: any) => (r.structuredContent as any).status;
const sc = (r: any) => r.structuredContent as any;

const books: string[] = [];
const SIDE_A = 'Now the sapphire ring glinted on the windowsill as she recalled it fondly and smiled to herself.';
const SIDE_B = 'Long ago, she had never seen the sapphire ring before that particular grey morning.';

// A generator that returns a fixed candidate set (supported + unsupported + one-sided + duplicate).
const STUB: RawAiResult = {
  candidates: [
    { type: 'knowledge', title: 'Daniella seems to know about the ring early', explanation: 'She references the ring before she is shown seeing it.', involved_entities: [{ kind: 'character', name: 'Daniella' }], evidence_targets: [{ quote_or_terms: 'the sapphire ring glinted on the windowsill' }, { quote_or_terms: 'she had never seen the sapphire ring before' }], claim_basis: 'positive_conflict', level_hint: 'likely_conflict', confidence: 0.8, question_for_writer: 'Did she learn about it earlier off-page?' },
    { type: 'timeline', title: 'Unsupported timeline claim', explanation: 'no evidence exists', evidence_targets: [{ quote_or_terms: 'a phrase that appears nowhere xyzzy qwerty' }], confidence: 0.6 },
    { type: 'character', title: 'One-sided strong claim', explanation: 'only one side', evidence_targets: [{ quote_or_terms: 'the sapphire ring glinted on the windowsill' }], level_hint: 'likely_conflict', confidence: 0.9 },
    { type: 'setup_payoff', title: 'Duplicate of deterministic thread', explanation: 'dup', involved_entities: [{ kind: 'thread', name: 'The locket' }], evidence_targets: [{ quote_or_terms: 'the sapphire ring glinted on the windowsill' }], confidence: 0.5 }
  ]
};
const gen = (result: RawAiResult, counter?: { n: number }) => async () => { if (counter) counter.n++; return result; };
const genThrow = async () => { throw new Error('provider down'); };

async function mkBook() { const { data } = await sb.from('books').insert({ user_id: OWNER, title: '__review_deep_test__', status: 'Planning' }).select('id').single(); books.push(data!.id); return data!.id; }
async function mkChapter(bid: string, n: number, secs: string[]) { const { data: ch } = await sb.from('chapters').insert({ book_id: bid, chapter_number: n, title: `Ch${n}`, sort_order: n - 1 }).select('id').single(); for (let i = 0; i < secs.length; i++) await sb.from('writing_sections').insert({ chapter_id: ch!.id, sort_order: i, content: secs[i], word_count: secs[i]!.split(/\s+/).length }); return ch!.id; }
const findingsOf = async (bid: string) => sc(await listReviewFindings(sb, { book_id: bid })).findings as any[];

try {
  const K = await mkBook();
  const c1 = await mkChapter(K, 1, [SIDE_B]);
  const c2 = await mkChapter(K, 2, [SIDE_A]);
  // deterministic setup_payoff for dedup target
  await sb.from('story_threads').insert({ book_id: K, title: 'The locket', status: 'Active', planned_payoff: 'the locket is opened', last_chapter_id: c1 });

  // Run deep with the stub
  const counter = { n: 0 };
  const r1 = await runDeepReview(sb, { book_id: K }, gen(STUB, counter));
  const f1 = await findingsOf(K);
  const ai = f1.filter((f) => f.source === 'ai');
  check('A/B: deep run ok, deterministic + ai findings present', st(r1) === 'ok' && f1.some((f) => f.source === 'deterministic'));
  check('C/F/P: supported AI candidate persisted (source ai)', ai.length === 1 && ai[0].finding_type === 'knowledge');
  check('F: supported knowledge finding has 2 evidence points', ai[0].evidence.length === 2 && ai[0].evidence.every((e: any) => e.chapter_id));
  check('M: two-sided + likely_conflict → likely_conflict level', ai[0].level === 'likely_conflict');
  check('D: unsupported candidate discarded', !ai.some((f) => /Unsupported/i.test(f.title)));
  check('E: one-sided strong claim discarded', !ai.some((f) => /One-sided/i.test(f.title)));
  check('N: AI duplicate of deterministic finding not created', !ai.some((f) => f.finding_type === 'setup_payoff') && f1.some((f) => f.source === 'deterministic' && f.finding_type === 'setup_payoff'));
  check('AF/AG: no prose/canon writes (canon_facts still 0)', (await sb.from('canon_facts').select('id', { count: 'exact', head: true }).eq('book_id', K)).count === 0);

  // U · hash gate: second identical deep run does NOT call the generator again
  await runDeepReview(sb, { book_id: K }, gen(STUB, counter));
  check('U: unchanged manuscript → generator not re-called (hash gate)', counter.n === 1);

  // T · material change → generator runs again
  await sb.from('writing_sections').update({ content: SIDE_A + ' And more new words appear here now.' }).eq('chapter_id', c2).eq('sort_order', 0);
  await runDeepReview(sb, { book_id: K }, gen(STUB, counter));
  check('T: material manuscript change → generator re-called', counter.n === 2);

  // Q/R/S · writer states persist across deep re-run
  const keep = (await findingsOf(K)).find((f) => f.source === 'ai')!;
  await sb.from('review_findings').update({ status: 'intentional' }).eq('id', keep.id);
  await sb.from('writing_sections').update({ content: SIDE_A + ' Another change to force rerun.' }).eq('chapter_id', c2).eq('sort_order', 0);
  await runDeepReview(sb, { book_id: K }, gen(STUB, counter));
  check('R: intentional AI finding persists across deep re-run', (await findingsOf(K)).find((f) => f.id === keep.id)?.status === 'intentional');

  // Y · AI failure preserves deterministic findings + existing AI findings
  const before = await findingsOf(K);
  await sb.from('writing_sections').update({ content: SIDE_A + ' Yet another change to force rerun again.' }).eq('chapter_id', c2).eq('sort_order', 0);
  const rf = await runDeepReview(sb, { book_id: K }, genThrow);
  check('Y: AI failure → ai_failed flag, deterministic preserved', sc(rf).ai_failed === true && (await findingsOf(K)).some((f) => f.source === 'deterministic'));
  check('Y: AI failure does not delete existing AI findings', (await findingsOf(K)).some((f) => f.source === 'ai'));

  // O · removed chapter excluded → AI evidence in it no longer resolves
  const O = await mkBook();
  const oc1 = await mkChapter(O, 1, [SIDE_B]);
  const oc2 = await mkChapter(O, 2, [SIDE_A]);
  await sb.from('chapters').update({ archived_at: new Date().toISOString() }).eq('id', oc2); // side A now inactive
  const ro = await runDeepReview(sb, { book_id: O }, gen(STUB));
  check('O: removed-chapter evidence excluded → knowledge finding not formed', !(await findingsOf(O)).some((f) => f.source === 'ai' && f.finding_type === 'knowledge' && f.evidence.length >= 2));

  // AD/AE · Add to Story Canon = pending proposal only (no canon write)
  const target = (await findingsOf(K)).find((f) => f.source === 'ai') ?? (await findingsOf(K))[0]!;
  const prop = await proposeCanonFromFinding(sb, { book_id: K, finding_id: target.id, fact: 'Timothy intends full-time ministry.' });
  check('AD: canon proposal created', st(prop) === 'ok' && typeof sc(prop).proposal_id === 'string');
  const { data: proposalRow } = await sb.from('story_bible_proposals').select('status, proposal_type').eq('id', sc(prop).proposal_id).single();
  check('AE: proposal is pending (requires approval), not written to canon', proposalRow!.status === 'pending' && proposalRow!.proposal_type === 'canon_fact' && (await sb.from('canon_facts').select('id', { count: 'exact', head: true }).eq('book_id', K)).count === 0);

  // AI/AJ/AK · RLS
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  check('AI: anon deep run → NOT_FOUND', st(await runDeepReview(anon, { book_id: K }, gen(STUB))) === 'NOT_FOUND');
  check('AK: anon canon proposal → NOT_FOUND', st(await proposeCanonFromFinding(anon, { book_id: K, finding_id: target.id, fact: 'x' })) === 'NOT_FOUND');
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
