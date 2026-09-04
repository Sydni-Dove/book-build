import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Book Build',
  description: 'A guided, page-by-page fiction-writing workspace.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
