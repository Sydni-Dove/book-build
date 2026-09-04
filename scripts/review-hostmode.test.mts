/**
 * MCP host-mode Deep Review split: get_deep_review_context (read, no provider)
 * + verify_and_persist_review_candidates (verify+persist untrusted host
 * candidates, no provider). Uses the service-role client; no real OpenAI calls.
 * Run: npx tsx scripts/review-hostmode.test.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { getDeepReviewContext, verifyAndPersistReviewCandidates, runDeepReview, runReview, listReviewFindings } from '../src/lib/mcp/tools.ts';
import { DEEP_REVIEW_SCHEMA } from '../src/lib/ai/review/deepReview.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const OWNER = '31271b9c-39f9-499e-a96c-c2e77661ee98';
const sb = createClient<Database>(url, svc, { auth: { persistSession: false } });
let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} — ${n}`); if (!c) failures++; };
const sc = (r: any) => r.structuredContent as any;
const st = (r: any) => sc(r).status;

const SIDE_A = 'Now the sapphire ring glinted on the windowsill as she recalled it fondly and smiled to herself.';
const SIDE_B = 'Long ago, she had never seen the sapphire ring before that particular grey morning.';
const cand = (over: any = {}) => ({ type: 'knowledge', title: 'Ring known too early', explanation: 'She references the ring before seeing it.', involved_entities: [{ kind: 'character', name: 'Daniella' }], evidence_targets: [{ quote_or_terms: 'the sapphire ring glinted on the windowsill' }, { quote_or_terms: 'she had never seen the sapphire ring before' }], level_hint: 'likely_conflict', confidence: 0.8, question_for_writer: 'Learned earlier off-page?', ...over });
const usageCount = async () => (await sb.from('ai_usage_log').select('id', { count: 'exact', head: true }).eq('user_id', OWNER)).count ?? 0;

const books: string[] = [];
async function mkBook() { const { data } = await sb.from('books').insert({ user_id: OWNER, title: '__hostmode_test__', status: 'Planning' }).select('id').single(); books.push(data!.id); return data!.id; }
async function mkChapter(bid: string, n: number, secs: string[]) { const { data: ch } = await sb.from('chapters').insert({ book_id: bid, chapter_number: n, title: `Ch${n}`, sort_order: n - 1 }).select('id').single(); for (let i = 0; i < secs.length; i++) await sb.from('writing_sections').insert({ chapter_id: ch!.id, sort_order: i, content: secs[i], word_count: secs[i]!.split(/\s+/).length }); return ch!.id; }
const aiFindings = async (bid: string) => (sc(await listReviewFindings(sb, { book_id: bid })).findings as any[]).filter((f) => f.source === 'ai');

try {
  const B = await mkBook();
  await mkChapter(B, 1, [SIDE_B]);
  await mkChapter(B, 2, [SIDE_A]);

  const usageBefore = await usageCount();

  // C · context tool: assembles context, no provider call
  const ctxR = await getDeepReviewContext(sb, { book_id: B });
  const ctx = sc(ctxR);
  check('C: context assembled (hash + digest + schema + instructions)', st(ctxR) === 'ok' && typeof ctx.manuscript_hash === 'string' && typeof ctx.digest === 'string' && !!ctx.candidate_schema && typeof ctx.instructions === 'string');
  check('X/Y: candidate_schema is the shared schema (host-neutral)', JSON.stringify(ctx.candidate_schema) === JSON.stringify(DEEP_REVIEW_SCHEMA));
  check('X/Y: context mentions no vendor-specific host', !/openai|anthropic|claude|chatgpt|gpt-/i.test(JSON.stringify(ctx)));

  // H · valid host candidate persists after verification
  const vR = await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: ctx.manuscript_hash, candidates: [cand()] });
  check('H: valid host candidate verified + persisted (source ai)', st(vR) === 'ok' && sc(vR).candidates_persisted === 1 && (await aiFindings(B)).length === 1);
  check('U/V: no manuscript/canon writes (canon_facts 0)', (await sb.from('canon_facts').select('id', { count: 'exact', head: true }).eq('book_id', B)).count === 0);

  // C/D/E · host flow created no ai_usage_log rows
  check('C/D/E: host context + verify created NO ai_usage_log row', (await usageCount()) === usageBefore);

  // I/J · unsupported + fake-quote candidates discarded
  const uR = await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: ctx.manuscript_hash, candidates: [cand({ title: 'Fake', evidence_targets: [{ quote_or_terms: 'phrase absent everywhere xyzzy qwerty plugh' }], level_hint: 'worth_checking' })] });
  check('I/J: unsupported/fake-quote candidate discarded (0 new)', st(uR) === 'ok' && sc(uR).candidates_persisted === 0 && sc(uR).discarded.some((d: any) => d.reason === 'no_evidence_located'));

  // L · malformed candidate rejected by sanitizer (missing explanation/evidence)
  const mR = await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: ctx.manuscript_hash, candidates: [cand(), { type: 'character', title: 'no evidence field' } as any] });
  check('L: malformed candidate rejected, valid one still persists', st(mR) === 'ok' && sc(mR).candidates_rejected_malformed >= 1 && sc(mR).candidates_persisted === 1);

  // M · excess candidate count bounded (truncated)
  const many = Array.from({ length: 15 }, (_, i) => cand({ title: `dup${i}`, evidence_targets: [{ quote_or_terms: 'nowhere zzzz' + i }] }));
  const exR = await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: ctx.manuscript_hash, candidates: many });
  check('M: excess candidate count bounded (truncated flag)', st(exR) === 'ok' && sc(exR).candidates_truncated === true && sc(exR).candidates_received === 15);

  // O/P/Q · writer states survive a host re-run. (Each verify is a COMPLETE AI
  // pass for the scope, so re-persist the supported candidate first, then rerun.)
  await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: ctx.manuscript_hash, candidates: [cand()] });
  const keep = (await aiFindings(B))[0];
  await sb.from('review_findings').update({ status: 'intentional' }).eq('id', keep.id);
  await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: ctx.manuscript_hash, candidates: [cand()] });
  check('O/P/Q: intentional state survives host re-run', (await aiFindings(B)).find((f) => f.id === keep.id)?.status === 'intentional');

  // R · stale manuscript hash blocks verification (nothing persisted)
  const staleR = await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: 'deadbeefstalehash', candidates: [cand({ title: 'should not persist' })] });
  check('R: stale hash → REVIEW_CONTEXT_CHANGED', st(staleR) === 'REVIEW_CONTEXT_CHANGED' && typeof sc(staleR).current_manuscript_hash === 'string');

  // K · invalid scope (not an active chapter) rejected
  const badScope = await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: '00000000-0000-0000-0000-000000000000', expected_manuscript_hash: ctx.manuscript_hash, candidates: [cand()] });
  check('K: invalid chapter scope → BAD_REQUEST', st(badScope) === 'BAD_REQUEST');

  // N · duplicate of a deterministic finding reconciles (host dup discarded)
  const D = await mkBook();
  const dc1 = await mkChapter(D, 1, [SIDE_B]);
  await mkChapter(D, 2, [SIDE_A]);
  await sb.from('story_threads').insert({ book_id: D, title: 'The locket', status: 'Active', planned_payoff: 'the locket is opened', last_chapter_id: dc1 });
  const dctx = sc(await getDeepReviewContext(sb, { book_id: D }));
  const dupR = await verifyAndPersistReviewCandidates(sb, { book_id: D, scope: 'book', expected_manuscript_hash: dctx.manuscript_hash, candidates: [cand({ type: 'setup_payoff', title: 'locket dup', involved_entities: [{ kind: 'thread', name: 'The locket' }], evidence_targets: [{ quote_or_terms: 'the sapphire ring glinted on the windowsill' }], level_hint: 'worth_checking' })] });
  check('N: host candidate duplicating a deterministic finding is discarded', sc(dupR).discarded.some((d: any) => d.reason === 'duplicate_of_deterministic') && (await aiFindings(D)).filter((f) => f.finding_type === 'setup_payoff').length === 0);

  // S · removed chapters excluded → SIDE_A evidence no longer locates
  const S = await mkBook();
  await mkChapter(S, 1, [SIDE_B]);
  const sc2ch = await mkChapter(S, 2, [SIDE_A]);
  await sb.from('chapters').update({ archived_at: new Date().toISOString() }).eq('id', sc2ch);
  const sctx = sc(await getDeepReviewContext(sb, { book_id: S }));
  const remR = await verifyAndPersistReviewCandidates(sb, { book_id: S, scope: 'book', expected_manuscript_hash: sctx.manuscript_hash, candidates: [cand()] });
  check('S: removed-chapter evidence excluded → knowledge finding not formed', sc(remR).candidates_persisted === 0);

  // F · host flow works even when OpenAI cost caps are exhausted
  process.env.AI_GLOBAL_DAILY_COST_LIMIT_USD = '0.00000001';
  const capCtx = sc(await getDeepReviewContext(sb, { book_id: B }));
  const capV = await verifyAndPersistReviewCandidates(sb, { book_id: B, scope: 'book', expected_manuscript_hash: capCtx.manuscript_hash, candidates: [cand()] });
  check('F: host context + verify work while OpenAI cap is exhausted', capCtx.manuscript_hash && st(capV) === 'ok');
  delete process.env.AI_GLOBAL_DAILY_COST_LIMIT_USD;

  // G · deterministic review still works; W · provider failure preserves deterministic
  check('G: deterministic review still works', st(await runReview(sb, { book_id: B })) === 'ok');
  const W = await mkBook(); // fresh book so the hash gate doesn't skip the (throwing) generator
  await mkChapter(W, 1, [SIDE_B]);
  await mkChapter(W, 2, [SIDE_A]);
  const wR = await runDeepReview(sb, { book_id: W }, async () => { throw new Error('provider down'); });
  check('W: standalone provider failure preserves deterministic + flags ai_failed', sc(wR).ai_failed === true && st(wR) === 'ok');

  // T · cross-user cannot access another book's context/verify (RLS)
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  check('T: anon get_deep_review_context → NOT_FOUND', st(await getDeepReviewContext(anon, { book_id: B })) === 'NOT_FOUND');
  check('T: anon verify_and_persist → NOT_FOUND', st(await verifyAndPersistReviewCandidates(anon, { book_id: B, scope: 'book', expected_manuscript_hash: ctx.manuscript_hash, candidates: [cand()] })) === 'NOT_FOUND');
} finally {
  for (const b of books) await sb.from('books').delete().eq('id', b);
  console.log('\n(fixtures cleaned up)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
