import type { NextConfig } from 'next';

const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST?.trim();
if (
  authEmulatorHost &&
  (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production')
) {
  throw new Error('FIREBASE_AUTH_EMULATOR_HOST must not be set in production.');
}

/**
 * Single Next.js application. Shared domain code lives under `lib/` and is
 * imported via the `@mt/*` path aliases (types, validation, domain, utils,
 * config, api-client) so the source stays organised without a monorepo.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  // Optional development tunnel hosts, not a production CORS allowlist.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  // One server-side switch configures BOTH SDKs. The host stays server-only;
  // remote browsers use same-origin rewrites instead of their own localhost.
  env: {
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_ENABLED: String(Boolean(authEmulatorHost)),
  },
  async rewrites() {
    if (!authEmulatorHost) return [];
    return ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'].map((host) => ({
      source: `/${host}/:path*`,
      destination: `http://${authEmulatorHost}/${host}/:path*`,
    }));
  },
  // Media is served through authorised API routes, never through the optimiser,
  // so remote patterns stay empty and `next/image` is not used for user media.
  images: { remotePatterns: [] },
  serverExternalPackages: ['firebase-admin'],
  output: 'standalone',
};

export default nextConfig;
