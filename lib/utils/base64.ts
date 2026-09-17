const encoder = new TextEncoder();

function decoder(): TextDecoder {
  return new TextDecoder();
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

export function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder().decode(bytes);
}

export function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(encodeUtf8(value));
}

export function base64UrlDecodeString(value: string): string {
  return decodeUtf8(base64UrlDecode(value));
}

/** Length independent comparison used for tokens and digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
