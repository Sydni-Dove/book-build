'use client';

import { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed';
  const variants: Record<string, string> = {
    primary: 'bg-accent text-white hover:bg-accent-strong',
    secondary: 'bg-white border border-line text-ink hover:border-accent',
    ghost: 'text-ink-soft hover:text-ink hover:bg-black/5',
    danger: 'bg-white border border-critical text-critical hover:bg-critical/5'
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface p-5 ${className}`}>{children}</div>;
}

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

// text-base (16px), not text-sm — a field under 16px triggers iOS Safari's
// auto-zoom-on-focus, breaking the "no fake zoom, real mobile usability"
// requirement on every screen that uses these, not just PLAN.
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-line bg-white px-3 py-2 text-base text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent ${props.className ?? ''}`}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-lg border border-line bg-white px-3 py-2 text-base text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent ${props.className ?? ''}`}
    />
  );
}

const statusStyles: Record<string, string> = {
  critical: 'bg-coral-soft text-accent-strong',
  should_address: 'bg-sunrise-soft text-gold-strong',
  optional: 'bg-confirmed-soft text-ink',
  neutral: 'bg-paper-sunken text-ink-soft'
};

// Uppercase eyebrow-style labels use Lato (the brand's sans), not a
// monospace face — Playfair is reserved for headings/titles, and the rest
// of the interface, small labels included, stays in Lato per the brand spec.
export function SeverityTag({ severity }: { severity: 'critical' | 'should_address' | 'optional' | 'neutral' }) {
  const labels: Record<string, string> = {
    critical: 'Critical',
    should_address: 'Should Address',
    optional: 'Optional',
    neutral: 'Note'
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${statusStyles[severity]}`}>
      {labels[severity]}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-line bg-paper px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-soft">
      {status}
    </span>
  );
}
