/**
 * Context-integrity regression test. Uses a tiny in-memory fake of the Supabase
 * query builder (only the chain methods traceSectionContext uses) seeded with a
 * fixture manuscript, and asserts the selection/relationship invariants the
 * Story-Intelligence gate requires. No DB, no network, no LLM. A fixture is
 * intentionally used — this proves the WIRING, not AWAKENED specifically.
 *
 * Run: npx tsx scripts/context-integrity.test.mts
 */
import { traceSectionContext } from '../src/lib/mcp/trace.ts';

// ---- fixture manuscript: Ch19 (3 sections) + Ch20 (1 section) --------------
const fixture: Record<string, any[]> = {
  books: [{ id: 'bk', title: 'Awakened' }],
  chapters: [
    { id: 'ch19', book_id: 'bk', chapter_number: 19, title: 'The Sting of Sweetness', sort_order: 18 },
    { id: 'ch20', book_id: 'bk', chapter_number: 20, title: 'Next Steps', sort_order: 19 }
  ],
  writing_sections: [
    { id: 's19a', chapter_id: 'ch19', sort_order: 0, title: 'The dream', status: 'Complete', content: 'Daniella was back in history class when the mocking voices began. The bee swarm gathered at the window.' },
    { id: 's19b', chapter_id: 'ch19', sort_order: 1, title: 'The sword', status: 'Complete', content: 'She spoke the Scripture aloud and the sword took shape in her hand. The Clown Lady recoiled from Proverbs 5.' },
    { id: 's19c', chapter_id: 'ch19', sort_order: 2, title: 'Rest before the meeting', status: 'Draft', content: 'She closed her notes on Deuteronomy 1. Tomorrow the group meeting. Tonight rest. She was ready for both.' },
    { id: 's20a', chapter_id: 'ch20', sort_order: 0, title: 'Morning', status: 'Draft', content: 'The group gathered in the fellowship hall.' }
  ],
  chapter_outlines: [
    { id: 'co19', chapter_id: 'ch19', is_current: true, purpose: 'Daniella wins the bee-spirit battle and grounds it in Scripture', chapter_end_state: 'She is ready to lead the group meeting' },
    { id: 'co20', chapter_id: 'ch20', is_current: true, purpose: 'The group reckons with what happened', chapter_end_state: 'A decision is made' }
  ],
  story_outline_nodes: [
    { id: 'node19', chapter_id: 'ch19', title: 'The Sting of Sweetness', purpose: 'Late-book character payoff: Daniella fights and understands', story_outline_id: 'so1' },
    { id: 'node20', chapter_id: 'ch20', title: 'Next Steps', purpose: 'Aftermath', story_outline_id: 'so1' }
  ],
  story_threads: [
    { id: 't_bee', book_id: 'bk', title: 'The Bee Spirit', status: 'Active' },
    { id: 't_done', book_id: 'bk', title: 'Old resolved thread', status: 'Resolved' }
  ],
  relationships: [{ id: 'r_dan_beth', book_id: 'bk' }],
  canon_facts: [{ id: 'cf1', book_id: 'bk' }, { id: 'cf2', book_id: 'bk' }]
};

function makeFakeSupabase(data: Record<string, any[]>) {
  const from = (table: string) => {
    let rows = [...(data[table] ?? [])];
    const b: any = {
      select() { return b; },
      eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return b; },
      in(col: string, vals: unknown[]) { rows = rows.filter((r) => vals.includes(r[col])); return b; },
      order(col: string, opts?: { ascending?: boolean }) { const asc = opts?.ascending !== false; rows = rows.sort((a, z) => (asc ? a[col] - z[col] : z[col] - a[col])); return b; },
      limit(n: number) { rows = rows.slice(0, n); return b; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } }); },
      then(onFulfilled: any) { return Promise.resolve({ data: rows, error: null }).then(onFulfilled); }
    };
    return b;
  };
  return { from } as any;
}

let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`); if (!cond) failures++; };

const sb = makeFakeSupabase(fixture);
const trace = await traceSectionContext(sb, 's19b');

check('requested section maps to expected chapter (ch19 / #19 / correct title)',
  trace.chapter?.id === 'ch19' && trace.chapter?.chapter_number === 19 && trace.chapter?.title === 'The Sting of Sweetness');
check('book resolves to Awakened', trace.book?.title === 'Awakened');
check('current prose comes from the requested section (s19b)',
  (trace.prose_first_150 ?? '').startsWith('She spoke the Scripture aloud'));
check('previous section is s19a (within chapter)', trace.previous_section?.id === 's19a');
check('next section is s19c (within chapter)', trace.next_section?.id === 's19c');
check('chapter outline belongs to ch19', trace.chapter_outline?.id === 'co19' && /bee-spirit battle/.test(trace.chapter_outline?.purpose ?? ''));
check('story-outline node relationship correct (node19 → ch19)',
  trace.story_outline_node?.id === 'node19' && trace.story_outline_node?.chapter_id === 'ch19');
check('threads are book-scoped and exclude Resolved', (trace.threads ?? []).some((t) => t.id === 't_bee') && !(trace.threads ?? []).some((t) => t.id === 't_done'));
check('no boundary crossing: next/prev never point into ch20',
  trace.previous_section?.id !== 's20a' && trace.next_section?.id !== 's20a');
check('no boundary crossing: outline/node are ch19, not ch20',
  trace.chapter_outline?.id !== 'co20' && trace.story_outline_node?.id !== 'node20');
check('trace has no integrity warnings', (trace.notes ?? []).length === 0);

// First section has no previous; last section has no next.
const first = await traceSectionContext(sb, 's19a');
const last = await traceSectionContext(sb, 's19c');
check('first section has null previous', first.previous_section === null);
check('last section has null next', last.next_section === null);

// Unknown section id → found:false, not a crash or wrong mapping.
const missing = await traceSectionContext(sb, 'does-not-exist');
check('unknown section id → found:false', missing.found === false);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
