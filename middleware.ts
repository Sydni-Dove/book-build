import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets, so the Supabase auth cookie
     * stays refreshed on every navigation. Auth pages are included on
     * purpose — updateSession also redirects signed-in users away from
     * /login and signed-out users away from protected routes.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
  ]
};
