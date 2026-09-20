import type { NextConfig } from 'next';

/**
 * Hosts the dev server may be reached from.
 *
 * `npm run dev` binds to `0.0.0.0` so a phone on the same network can open the
 * app, but Next.js additionally refuses cross-origin requests to its *dev-only*
 * resources (the HMR socket, the dev overlay, the RSC payload) unless the
 * request's host is listed here. Blocking that HMR upgrade does not fail
 * loudly: the server-rendered HTML still appears, the client bundle still
 * loads, yet the React tree never hydrates — so nothing on the page is
 * interactive and keystrokes are never observed. In this app that is exactly
 * the "I typed the unlock code and nothing happened" report.
 *
 * A single hardcoded LAN address is not enough: the DHCP lease changes, and a
 * phone may reach the machine by name (`laptop.local`) instead of by IP. Local
 * network addresses and mDNS names are allowed by default below; add your own
 * with `ALLOWED_DEV_ORIGINS` (comma separated hostnames, `*` wildcards match a
 * DNS segment, e.g. `dev.example.com` or `192.168.*.*`). This is a
 * development-only setting — production serves everything from one origin.
 */
function allowedDevOrigins(): string[] {
  const fromEnv = (process.env.ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const localNetwork = [
    '127.0.0.1', // loopback by IP — Next only allows `localhost` by itself
    '192.168.*.*', // typical home/office Wi-Fi
    '10.*.*.*', // typical larger LAN
    '172.*.*.*', // docker/VPN/private ranges
    '169.254.*.*', // link-local / directly connected devices
    '**.local', // mDNS names: laptop.local, phone.local, …
  ];
  // `localhost` and `**.localhost` are always allowed by Next.js.
  return Array.from(new Set([...localNetwork, ...fromEnv]));
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
  // Media is served through authorised API routes, never through the optimiser,
  // so remote patterns stay empty and `next/image` is not used for user media.
  images: { remotePatterns: [] },
  output: 'standalone',
  allowedDevOrigins: allowedDevOrigins(),
};

export default nextConfig;
