import type { Metadata, Viewport } from 'next';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-full antialiased">
        <RootProviders>{children}</RootProviders>
      </body>
    </html>
  );
}
