/**
 * Absence-confidence guard for Review & Continuity. Bounded retrieval means
 * "I didn't find X" must not become "X is absent". Tests the shared verifier
 * (standalone) directly AND through the MCP-host verify/persist path so both
 * providers demonstrably inherit the same rules. No real OpenAI calls.
 * Run: npx tsx scripts/review-absence.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { verifyAiCandidatesDetailed, type DeepInput } from '../src/lib/ai/review/deepReview.ts';
import { computeContinuityFindings } from '../src/lib/ai/review/continuity.ts';
import { getDeepReviewContext, verifyAndPersistReviewCandidates, listReviewFindings } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });
let fail = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) fail++; };
const sc = (r: any) => r.structuredContent as any;

// Build a minimal DeepInput from (chapter, id, text) rows.
const mkDI = (secs: { id: string; ch: number; text: string }[]): DeepInput => {
  const chMap = new Map<number, any>();
  for (const s of secs) if (!chMap.has(s.ch)) chMap.set(s.ch, { id: `c${s.ch}`, chapter_number: s.ch, title: `Ch${s.ch}`, sort_order: s.ch - 1 });
  return { chapters: [...chMap.values()], sections: secs.map((s, i) => ({ id: s.id, chapter_id: `c${s.ch}`, sort_order: i, title: null, content: s.text })), threads: [], relationships: [], canonFacts: [], timeline: [], characterNames: [] };
};
const verify = (di: DeepInput, cands: any[]) => verifyAiCandidatesDetailed(di, di.sections as never, { candidates: cands }, new Set());

const BEFORE = "Jordan had been Daniella's boyfriend since the spring formal.";
const AFTER = "By autumn Timothy was Daniella's serious boyfriend and her parents approved.";
const BRIDGE = "That summer Daniella and Jordan broke up, and weeks later Timothy asked her out.";
const progGap = (over: any = {}) => ({ type: 'relationship', title: 'Jordan to Timothy transition', claim_basis: 'progression_gap', level_hint: 'likely_conflict', explanation: 'Jordan is her boyfriend earlier and Timothy later.', involved_entities: [{ kind: 'character', name: 'Jordan' }, { kind: 'character', name: 'Timothy' }], evidence_targets: [{ quote_or_terms: "Jordan had been Daniella's boyfriend since the spring formal" }, { quote_or_terms: "Timothy was Daniella's serious boyfriend and her parents approved" }], confidence: 0.9, ...over });

const books: string[] = [];
async function mkBook() { const { data } = await sb.from('books').insert({ user_id: OWNER, title: '__absence_test__', status: 'Planning' }).select('id').single(); books.push(data!.id); return data!.id; }
async function mkChapter(bid: string, n: number, text: string) { const { data: ch } = await sb.from('chapters').insert({ book_id: bid, chapter_number: n, title: `Ch${n}`, sort_order: n - 1 }).select('id').single(); await sb.from('writing_sections').insert({ chapter_id: ch!.id, sort_order: 0, content: text, word_count: text.split(/\s+/).length }); return ch!.id; }
const aiFindings = async (bid: string) => (sc(await listReviewFindings(sb, { book_id: bid })).findings as any[]).filter((f) => f.source === 'ai');

try {
  // 2 · progression before/after, no bridge → Worth Checking (NOT Likely Conflict)
  const di2 = mkDI([{ id: 's1', ch: 1, text: BEFORE }, { id: 's2', ch: 2, text: AFTER }]);
  const r2 = verify(di2, [progGap()]);
  const f2 = r2.kept[0];
  check('2: progression gap (no bridge) kept as worth_checking, not likely_conflict', r2.kept.length === 1 && f2.level === 'worth_checking');

  // 3 · absence finding uses uncertainty language, no absolutes
  check('3: absence finding uses calibrated uncertainty language', /material reviewed/i.test(f2.explanation) && !/is missing|no scene|author forgot|never shown/i.test(f2.explanation) && /shown elsewhere|another beat/i.test(f2.question));

  // 9 · host submits absence_based + Likely Conflict → server downgrades
  const r9 = verify(di2, [progGap({ claim_basis: 'absence_based', level_hint: 'likely_conflict' })]);
  check('9: absence_based + likely_conflict submitted → downgraded to worth_checking', r9.kept[0].level === 'worth_checking');

  // 10 · absolute absence language calibrated on persist
  const r10 = verify(di2, [progGap({ explanation: 'The transition is missing and the author forgot to show it.' })]);
  check('10: absolute language ("missing"/"forgot") calibrated away', !/missing/i.test(r10.kept[0].explanation) && !/forgot/i.test(r10.kept[0].explanation) && /material reviewed|passages reviewed/i.test(r10.kept[0].explanation));

  // 4 · broader search finds the bridge → candidate discarded
  const di4 = mkDI([{ id: 's1', ch: 1, text: BEFORE }, { id: 's2', ch: 2, text: AFTER }, { id: 's3', ch: 3, text: BRIDGE }]);
  const r4 = verify(di4, [progGap()]);
  check('4: broader search locates bridge → candidate discarded', r4.kept.length === 0 && r4.discarded.some((d) => d.reason === 'bridge_located'));

  // 1 · explicit contradictory facts → Likely Conflict
  const di1 = mkDI([{ id: 's1', ch: 1, text: 'Daniella was twelve years old that winter.' }, { id: 's2', ch: 2, text: 'Daniella was fifteen years old that same winter.' }]);
  const c1 = { type: 'character', title: 'Age conflict', claim_basis: 'positive_conflict', level_hint: 'likely_conflict', explanation: 'Two incompatible ages at the same time.', involved_entities: [{ kind: 'character', name: 'Daniella' }], evidence_targets: [{ quote_or_terms: 'Daniella was twelve years old that winter' }, { quote_or_terms: 'Daniella was fifteen years old that same winter' }], confidence: 0.9 };
  check('1: affirmative contradictory facts → likely_conflict', verify(di1, [c1]).kept[0]?.level === 'likely_conflict');

  // 7 · chronology affirmatively proves impossible knowledge → Likely Conflict
  const di7 = mkDI([{ id: 's1', ch: 1, text: 'She already knew the vault code before the meeting.' }, { id: 's2', ch: 2, text: 'The vault code stayed sealed and unknown until the final night.' }]);
  const c7 = { type: 'knowledge', title: 'Knows code too early', claim_basis: 'positive_conflict', level_hint: 'likely_conflict', explanation: 'She knows the code before it is available.', involved_entities: [{ kind: 'character', name: 'Daniella' }], evidence_targets: [{ quote_or_terms: 'She already knew the vault code before the meeting' }, { quote_or_terms: 'The vault code stayed sealed and unknown until the final night' }], confidence: 0.85 };
  check('7: affirmative impossible-knowledge → likely_conflict', verify(di7, [c7]).kept[0]?.level === 'likely_conflict');

  // TP · a state change across DISTANT chapters is progression over time, not a
  // contradiction → downgraded to worth_checking with a change-over-time question.
  const diTP = mkDI([
    { id: 'sa', ch: 2, text: 'It was two weeks later and Daniella had not seen or heard from Ashley since that difficult day at all.' },
    { id: 'sb', ch: 13, text: 'The next morning Daniella texted Ashley about the upcoming baptism and Ashley replied right away with excitement.' }
  ]);
  const cTP = (over: any = {}) => ({ type: 'relationship', title: 'Ashley contact: none vs texting', claim_basis: 'positive_conflict', level_hint: 'likely_conflict', explanation: 'One scene shows no contact; a later scene shows texting.', involved_entities: [{ kind: 'character', name: 'Ashley' }, { kind: 'character', name: 'Daniella' }], evidence_targets: [{ quote_or_terms: 'Daniella had not seen or heard from Ashley since that difficult day' }, { quote_or_terms: 'Daniella texted Ashley about the upcoming baptism and Ashley replied' }], confidence: 0.9, ...over });
  const rTP = verify(diTP, [cTP()]);
  check('TP: cross-chapter state change downgraded to worth_checking (not likely_conflict)', rTP.kept[0]?.level === 'worth_checking');
  check('TP: reframed as a change-over-time question', /change over time|different states|different points/i.test(rTP.kept[0]?.question ?? ''));

  // TP2 · the SAME kind of conflict within a close time window stays likely_conflict.
  const diTP2 = mkDI([
    { id: 'sa', ch: 2, text: 'Daniella had not seen or heard from Ashley since that difficult day, not once, not at all.' },
    { id: 'sb', ch: 3, text: 'Daniella texted Ashley about the upcoming baptism and Ashley replied that same afternoon.' }
  ]);
  check('TP2: same-timeframe (close chapters) conflict stays likely_conflict', verify(diTP2, [cTP()]).kept[0]?.level === 'likely_conflict');

  // 5 · setup/payoff not located → Worth Checking (absence overrides open_question)
  const di5 = mkDI([{ id: 's1', ch: 1, text: 'A locked cedar box sat in the attic, its small brass key long lost.' }]);
  const c5 = { type: 'setup_payoff', title: 'Cedar box setup', claim_basis: 'absence_based', explanation: 'A locked cedar box is introduced.', involved_entities: [{ kind: 'object', name: 'cedar box' }], evidence_targets: [{ quote_or_terms: 'A locked cedar box sat in the attic' }], confidence: 0.6 };
  const r5 = verify(di5, [c5]);
  check('5: setup/payoff not located → worth_checking', r5.kept[0]?.level === 'worth_checking');

  // 6 · knowledge acquisition not located → Worth Checking
  const di6 = mkDI([{ id: 's1', ch: 1, text: 'She knew the old lullaby by heart.' }, { id: 's2', ch: 2, text: 'No one in the family had ever sung that lullaby to her.' }]);
  const c6 = { type: 'knowledge', title: 'Lullaby known, source unshown', claim_basis: 'progression_gap', level_hint: 'likely_conflict', explanation: 'She knows the lullaby but the source is not shown.', involved_entities: [{ kind: 'character', name: 'Daniella' }], evidence_targets: [{ quote_or_terms: 'She knew the old lullaby by heart' }, { quote_or_terms: 'No one in the family had ever sung that lullaby to her' }], confidence: 0.8 };
  check('6: knowledge acquisition not located → worth_checking', verify(di6, [c6]).kept[0]?.level === 'worth_checking');

  // 8 · intentional sequel thread not flagged as a failed payoff (deterministic)
  const seqInput: any = { chapters: [{ id: 'c1', chapter_number: 1, title: 'Ch1', sort_order: 0 }], sections: [], threads: [{ id: 't1', title: 'The prophecy', status: 'Active', next_expected_beat: 'sequel', planned_payoff: 'the prophecy is fulfilled', last_chapter_id: 'c1', description: 'a long arc' }], canonFacts: [], canonConflicts: [], relationships: [], timelineEvents: [], characterNames: new Map() };
  check('8: intentional sequel thread not flagged', computeContinuityFindings(seqInput).length === 0);

  // ---- Host path: identical rules + reconciliation + no writes/usage ----
  const B = await mkBook();
  await mkChapter(B, 1, BEFORE);
  await mkChapter(B, 2, AFTER);
  const usageBefore = (await sb.from('ai_usage_log').select('id', { count: 'exact', head: true }).eq('user_id', OWNER)).count ?? 0;
  const hash = sc(await getDeepReviewContext(sb, { book_id: B })).manuscript_hash;

  // 15 · standalone verifier level === host-persisted level for the same candidate
  await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: hash, candidates: [progGap()] });
  const hostF = (await aiFindings(B))[0];
  check('15: standalone and host paths apply identical ceiling (worth_checking)', hostF.level === 'worth_checking' && hostF.level === f2.level);
  check('16/17: no manuscript/canon writes (canon_facts 0)', (await sb.from('canon_facts').select('id', { count: 'exact', head: true }).eq('book_id', B)).count === 0);
  check('18: host verify created no OpenAI usage row', ((await sb.from('ai_usage_log').select('id', { count: 'exact', head: true }).eq('user_id', OWNER)).count ?? 0) === usageBefore);

  // 11/12/13 · writer states survive a host re-run
  for (const status of ['intentional', 'resolved', 'watch'] as const) {
    await sb.from('review_findings').update({ status }).eq('id', hostF.id);
    await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: hash, candidates: [progGap()] });
    const after = (await aiFindings(B)).find((f) => f.id === hostF.id);
    check(`${status === 'intentional' ? '11' : status === 'resolved' ? '12' : '13'}: ${status} state survives host re-run`, after?.status === status);
  }

  // 14 · same fingerprint updates instead of duplicating (and level recalibrates in place)
  await sb.from('review_findings').update({ status: 'open' }).eq('id', hostF.id);
  await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: hash, candidates: [progGap({ claim_basis: 'positive_conflict' })] }); // now qualifies as likely_conflict
  const upd = await aiFindings(B);
  check('14: same fingerprint updates in place (no duplicate), level recalibrated', upd.length === 1 && upd[0].id === hostF.id && upd[0].level === 'likely_conflict');
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)'}`);
process.exit(fail === 0 ? 0 : 1);
