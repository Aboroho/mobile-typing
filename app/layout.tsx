import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import '@/styles/globals.css';
import { RootProviders } from '@/components/providers';

export const metadata: Metadata = {
  title: 'Keypad — typing practice',
  description: 'A lightweight typing practice game for English and Bengali.',
  applicationName: 'Keypad',
  // Deliberately neutral: nothing here may hint at a messaging application.
  keywords: ['typing', 'practice', 'wpm', 'bengali', 'english'],
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
  // Allow modest pinch-zoom on desktop/accessibility tools; mobile layout still fits.
  maximumScale: 5,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers() forces this layout (and therefore every page under it)
  // to render dynamically per request, which is required for the proxy's
  // per-request CSP nonce to line up with the one Next.js stamps onto its own
  // inline hydration scripts. Without this, a statically-generated page would
  // ship a stale/absent nonce and every visitor's browser would silently
  // refuse to run the hydration scripts — the page loads but never becomes
  // interactive (buttons stay disabled, "Loading…" states never resolve).
  await headers();

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-full antialiased">
        <RootProviders>{children}</RootProviders>
      </body>
    </html>
  );
}
