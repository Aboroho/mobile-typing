import type { NextResponse } from 'next/server';
import { cookieOptions } from './types';

/** Parses the `Cookie` header without needing a Next request context (testable). */
export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie');
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function readCookie(request: Request, name: string): string | null {
  return parseCookies(request)[name] ?? null;
}

export function setCookie(
  response: NextResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
): NextResponse {
  response.cookies.set(name, value, { ...cookieOptions, maxAge: maxAgeSeconds });
  return response;
}

export function clearCookie(response: NextResponse, name: string): NextResponse {
  response.cookies.set(name, '', { ...cookieOptions, maxAge: 0 });
  return response;
}
