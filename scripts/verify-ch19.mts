/**
 * LIVE_DATA verification: run the deterministic Context-Integrity Trace and the
 * real get_development_briefing against the imported Chapter 19 section.
 * Reads live Supabase rows via a service-role client (diagnostic; read-only).
 * Run: npx tsx scripts/verify-ch19.mts
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { traceSectionContext } from '../src/lib/mcp/trace.ts';
import { getDevelopmentBriefing } from '../src/lib/mcp/tools.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BOOK = '69c4e5ca-2529-4aab-9126-32873894d804';
const CH19_SECTION = '11f65c74-5a30-44a9-a30d-6945c34bd924';

const sb = createClient<Database>(url, key, { auth: { persistSession: false } });

const { count: chapters } = await sb.from('chapters').select('*', { count: 'exact', head: true }).eq('book_id', BOOK);
const { data: secRows } = await sb.from('writing_sections').select('id, chapter_id').limit(1000);
console.log(`LIVE_DATA counts: chapters=${chapters} sections=${secRows?.length}`);

console.log('\n================ CONTEXT-INTEGRITY TRACE (LIVE_DATA) ================');
const trace = await traceSectionContext(sb, CH19_SECTION);
console.log(JSON.stringify(trace, null, 2));

console.log('\n================ get_development_briefing (LIVE_DATA) ================');
const res = await getDevelopmentBriefing(sb, { section_id: CH19_SECTION, focus: 'auto' });
const sc: any = res.structuredContent;
console.log(JSON.stringify({
  identity: sc.identity,
  arc_position: sc.arc_position,
  threads: sc.threads,
  relationships: sc.relationships,
  character_facts: sc.character_facts?.slice(0, 3),
  information_state: sc.information_state,
  world_rules: sc.world_rules,
  dream_revelation: sc.dream_revelation,
  development_decisions: sc.development_decisions,
  open_questions: sc.open_questions,
  working_notes: sc.working_notes,
  candidate_items_for_attention: sc.candidate_items_for_attention,
  signals: sc.signals,
  guidance: { active_modules: sc.guidance?.active_modules },
  meta: sc.meta
}, null, 2));
