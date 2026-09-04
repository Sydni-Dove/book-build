import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

// PKCE code-exchange landing for Supabase auth links (password recovery, and any
// future magic-link / OAuth). The email link arrives here as `?code=...`; we
// exchange it for a session cookie server-side (the @supabase/ssr browser client
// stored the matching PKCE verifier in a cookie on the same origin), then send
// the user on to `next`. No token/secret is ever logged or returned in the URL.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/reset-password';

  // Production-vs-local origin: behind Vercel the public host is on
  // x-forwarded-host; locally use the request origin as-is.
  const isLocal = process.env.NODE_ENV === 'development';
  const forwardedHost = request.headers.get('x-forwarded-host');
  const base = isLocal ? url.origin : forwardedHost ? `https://${forwardedHost}` : url.origin;

  if (code) {
    const supabase = createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${base}${next}`);
  }
  // Exchange failed or no code — send back to login rather than a raw 500.
  return NextResponse.redirect(`${base}/login?error=auth_callback`);
}
