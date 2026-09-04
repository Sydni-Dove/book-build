'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Button, Card, Field, Input } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push(searchParams.get('next') || '/dashboard');
    router.refresh();
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p className="text-sm text-critical">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
        <div className="flex justify-between text-sm text-ink-soft">
          <Link href="/signup" className="hover:text-accent-strong">
            Create an account
          </Link>
          <Link href="/reset-password" className="hover:text-accent-strong">
            Forgot password?
          </Link>
        </div>
      </form>
    </Card>
  );
}

// useSearchParams() opts a page out of static prerendering unless it's
// wrapped in Suspense — the login link can carry ?next=/some/protected/path
// (see middleware.ts), so this boundary is required, not decorative.
export default function LoginPage() {
  return (
    <Suspense fallback={<Card><p className="text-sm text-ink-faint">Loading…</p></Card>}>
      <LoginForm />
    </Suspense>
  );
}
