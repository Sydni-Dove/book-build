/**
 * CLEAN SI-1 fresh-host flow. Simulates a host that starts with nothing but the
 * MCP read tools and the user's prompt. It (1) pulls the structured briefing +
 * retrieval_plan, (2) pulls local prose via get_writing_context, (3) follows the
 * plan by calling search_manuscript for story-relevant passages. It prints every
 * retrieval so the reasoning can be audited against ONLY freshly-retrieved data.
 * Run: npx tsx scripts/si1-fresh.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { getDevelopmentBriefing, getWritingContext, searchManuscript } from '../src/lib/mcp/tools.ts';

const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const BOOK = '69c4e5ca-2529-4aab-9126-32873894d804';
const CH21 = '41823edc-9371-4696-968f-31101ab57235'; // latest written section

const brief = await getDevelopmentBriefing(sb, { section_id: CH21, focus: 'auto' });
const s: any = brief.structuredContent;
console.log('### (1) get_development_briefing(Ch21) — structured');
console.log(JSON.stringify({
  current_state: s.arc_position.current_state,
  unresolved_threads: s.threads.map((t: any) => ({ title: t.title, status: t.status, last_recorded_chapter_number: t.last_recorded_chapter_number, elapsed: t.elapsed_chapters_since_recorded_movement })),
  candidate_items_for_attention: s.candidate_items_for_attention,
  signals: s.signals.map((x: any) => x.value),
  relationships: s.relationships.map((r: any) => ({ a: r.a, b: r.b, status: r.current_status })),
  development_decisions: s.development_decisions.map((d: any) => d.fact),
  retrieval_plan: s.retrieval_plan
}, null, 2));

console.log('\n### (2) get_writing_context(Ch21) — local prose');
const wc: any = (await getWritingContext(sb, { section_id: CH21 })).structuredContent;
console.log(JSON.stringify({ current_section: wc.structured?.current_section?.content?.slice(0, 220), chapter: wc.structured?.chapter }, null, 2));

console.log('\n### (3) search_manuscript — following the plan (distinctive terms; near_chapter for late-book relevance)');
const searches: { why: string; query: string; near?: number }[] = [
  { why: "Bee/Counterfeit thread origin (plan anchor Ch4) — narrowed to a distinctive term", query: 'swarm' },
  { why: "Ashley thread, recent state near the current point", query: 'Ashley', near: 21 },
  { why: "Ashley's family / brother (open portion evidence)", query: 'brother' },
  { why: "Daniella/Timothy relationship beat, recent", query: 'marriage|the one', near: 21 },
  { why: "Selah, recent", query: 'Selah', near: 21 }
];
for (const sch of searches) {
  const r: any = (await searchManuscript(sb, { book_id: BOOK, query: sch.query, limit: 3, near_chapter: sch.near })).structuredContent;
  console.log(`\n-- ${sch.why}\n   query="${sch.query}"${sch.near ? ` near_chapter=${sch.near}` : ''} → ${r.matches?.length} match(es)`);
  for (const m of r.matches ?? []) console.log(`   [Ch${m.chapter_number}] ${m.excerpt.slice(0, 190)}`);
}
