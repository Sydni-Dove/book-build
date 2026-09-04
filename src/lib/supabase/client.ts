import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

// Browser-side client — respects RLS as the signed-in user. This is the
// client every autosave call and every Story Canon edit goes through.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
