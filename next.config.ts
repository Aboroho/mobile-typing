import type { NextConfig } from 'next';

/**
 * Single Next.js application. Shared domain code lives under `lib/` and is
 * imported via the `@mt/*` path aliases (types, validation, domain, utils,
 * config, api-client) so the source stays organised without a monorepo.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  // Media is served through authorised API routes, never through the optimiser,
  // so remote patterns stay empty and `next/image` is not used for user media.
  images: { remotePatterns: [] },
  output: 'standalone',
};

export default nextConfig;
