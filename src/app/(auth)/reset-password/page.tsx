'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button, Card, Field, Input } from '@/components/ui';

export default function ResetPasswordPage() {
  const supabase = createClient();
  const router = useRouter();

  // Two phases in one route: (1) request a reset email, and (2) — after the
  // recovery link + /auth/callback have established a session — set a new
  // password. We show phase 2 whenever an active session is detected.
  const [recovering, setRecovering] = useState(false);

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active && data.session) setRecovering(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setRecovering(true);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [supabase]);

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // Land on the PKCE code-exchange route, which then returns here to set the
    // new password. window.location.origin is the production origin in prod.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`
    });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setSent(true);
  }

  async function saveNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setSaved(true);
    // Session is now valid with the new password — continue into the app.
    setTimeout(() => router.replace('/dashboard'), 900);
  }

  return (
    <Card>
      {recovering ? (
        saved ? (
          <p className="text-sm text-ink">Password updated. Taking you to your dashboard…</p>
        ) : (
          <form onSubmit={saveNewPassword} className="space-y-4">
            <p className="text-sm text-ink">Choose a new password for your account.</p>
            <Field label="New password">
              <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" />
            </Field>
            {error && <p className="text-sm text-critical">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Saving…' : 'Save new password'}
            </Button>
          </form>
        )
      ) : sent ? (
        <p className="text-sm text-ink">
          If an account exists for <strong>{email}</strong>, a reset link is on its way.
        </p>
      ) : (
        <form onSubmit={requestReset} className="space-y-4">
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          {error && <p className="text-sm text-critical">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
      <Link href="/login" className="mt-4 block text-center text-sm text-accent-strong hover:underline">
        Back to sign in
      </Link>
    </Card>
  );
}
