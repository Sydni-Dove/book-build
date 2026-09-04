import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/types/database.ts';
import { searchManuscript } from '../src/lib/mcp/tools.ts';

const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const BOOK = '69c4e5ca-2529-4aab-9126-32873894d804';

for (const q of ['swarm of bees|swarm', 'little brother', 'marriage in view|pastor']) {
  const r: any = (await searchManuscript(sb, { book_id: BOOK, query: q, limit: 5 })).structuredContent;
  console.log(`\n== ${q} -> ${r.matches.length}`);
  for (const m of r.matches) console.log(`  [Ch${m.chapter_number}] ${m.excerpt.slice(0, 150)}`);
}
