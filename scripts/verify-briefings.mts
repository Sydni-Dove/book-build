import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { getDevelopmentBriefing } from '../src/lib/mcp/tools.ts';

const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const targets = [
  { label: 'Ch19 The Sting of Sweetness', section: '11f65c74-5a30-44a9-a30d-6945c34bd924' },
  { label: 'Ch20 Next Steps',            section: '68f665e5-dbb8-4c9d-b572-1671b81df23a' },
  { label: 'Ch21 A Clean Room',          section: '41823edc-9371-4696-968f-31101ab57235' }
];

for (const t of targets) {
  const r = await getDevelopmentBriefing(sb, { section_id: t.section, focus: 'auto' });
  const s: any = r.structuredContent;
  console.log(`\n================ ${t.label} (LIVE_DATA) ================`);
  console.log(JSON.stringify({
    current_state: s.arc_position?.current_state,
    unresolved_threads: s.threads?.map((x: any) => ({ title: x.title, status: x.status, planned_payoff: (x.planned_payoff||'').slice(0,50) })),
    relationships: s.relationships?.map((x: any) => ({ a: x.a, b: x.b, type: x.current_status })),
    character_facts_count: s.character_facts?.length,
    information_state: s.information_state,
    development_decisions: s.development_decisions?.map((d: any) => d.fact.slice(0, 90)),
    working_notes_count: s.working_notes?.length,
    candidate_items_for_attention: s.candidate_items_for_attention?.map((c: any) => c.statement),
    signals: s.signals?.map((x: any) => x.value),
    guidance_modules: s.guidance?.active_modules,
    llm_used: s.meta?.llm_used
  }, null, 2));
}
