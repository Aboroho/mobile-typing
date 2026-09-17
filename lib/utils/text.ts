import { MESSAGE_PREVIEW_LENGTH } from '@mt/types';

/** Characters that never belong in user text and can break rendering or logs. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

export function normalizeText(value: string): string {
  return stripControlChars(value.normalize('NFC'));
}

export function truncate(value: string, max = MESSAGE_PREVIEW_LENGTH): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

export function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? '';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? '?').toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}

export function maskSecret(value: string): string {
  if (value.length <= 2) return '••';
  return `${'•'.repeat(Math.max(3, value.length - 1))}`;
}
