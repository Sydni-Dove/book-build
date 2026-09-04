import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';

export default async function RootPage({ searchParams }: { searchParams: { code?: string } }) {
  // Defensive: if an auth link ever lands on "/" with a PKCE code (e.g. the
  // Supabase Site URL is "/"), forward it to the code-exchange route instead of
  // rendering a session-less page.
  if (searchParams?.code) {
    redirect(`/auth/callback?code=${encodeURIComponent(searchParams.code)}&next=/reset-password`);
  }
  const supabase = createServerSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  redirect(user ? '/dashboard' : '/login');
}
