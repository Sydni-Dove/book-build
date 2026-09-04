export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center font-display text-2xl text-ink">Book Build</p>
        {children}
      </div>
    </div>
  );
}
