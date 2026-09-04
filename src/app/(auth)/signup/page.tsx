'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Button, Card, Field, Input } from '@/components/ui';

export default function SignupPage() {
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName || undefined } }
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <Card>
        <p className="text-sm text-ink">
          Check <strong>{email}</strong> for a confirmation link. Once you confirm, you can sign in.
        </p>
        <Link href="/login" className="mt-4 block text-sm text-accent-strong hover:underline">
          Back to sign in
        </Link>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Name" hint="Optional — shown in the app only.">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p className="text-sm text-critical">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </Button>
        <p className="text-center text-sm text-ink-soft">
          Already have an account?{' '}
          <Link href="/login" className="text-accent-strong hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </Card>
  );
}
