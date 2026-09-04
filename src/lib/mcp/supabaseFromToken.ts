import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

/**
 * Per-request Supabase client bound to a signed-in user's access token. Every
 * PostgREST call it makes carries that JWT, so the EXISTING row-level-security
 * policies apply unchanged — the MCP layer never bypasses RLS and never uses
 * the service-role key. This is how "authentication using existing Supabase
 * identity/RLS" is honored: the bearer token IS a Supabase session token.
 */
export function supabaseFromToken(accessToken: string): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    }
  );
}

/** Validate a bearer token as a Supabase session and return the user id. */
export async function verifySupabaseToken(accessToken: string): Promise<{ userId: string } | null> {
  const client = supabaseFromToken(accessToken);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id };
}
