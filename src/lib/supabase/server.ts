import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types/database';

// Server-side client for Server Components, Server Actions, and Route
// Handlers. Still runs as the signed-in user (RLS applies) — this is NOT
// the service-role client. Use this everywhere except the one place below.
export function createServerSupabase() {
  const cookieStore = cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // called from a Server Component with no writable cookie jar —
            // middleware.ts already refreshes the session on every request,
            // so this is safe to ignore.
          }
        }
      }
    }
  );
}

// Service-role client — bypasses RLS. Only ever used inside API routes,
// and only AFTER we've independently verified the caller's session via
// createServerSupabase().auth.getUser(). Never imported into client code.
import { createClient } from '@supabase/supabase-js';

export function createServiceSupabase() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
