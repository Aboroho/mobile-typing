import type { NextConfig } from 'next';

/**
 * Internal workspace packages ship TypeScript sources, so Next compiles them
 * together with the app. This is what makes `@mt/*` imports work without a
 * separate build step (and keeps one source of truth for a future RN client).
 */
const transpilePackages = [
  '@mt/types',
  '@mt/validation',
  '@mt/domain',
  '@mt/api-client',
  '@mt/utils',
  '@mt/config',
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  // Media is served through authorised API routes, never through the optimiser,
  // so remote patterns stay empty and `next/image` is not used for user media.
  images: { remotePatterns: [] },
  serverExternalPackages: ['firebase-admin'],
  output: 'standalone',
};

export default nextConfig;
