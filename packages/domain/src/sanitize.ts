import { MESSAGE_MAX_LENGTH } from '@mt/types';
import { normalizeText, stripControlChars, truncate } from '@mt/utils';

const MAX_CONSECUTIVE_NEWLINES = 8;

/**
 * Server side normalisation of message text. React escapes everything by
 * default, so the goal here is not XSS filtering but keeping stored content
 * predictable: unicode normalised, control characters and bidi overrides
 * removed, newlines bounded and length capped.
 */
export function sanitizeMessageText(input: string): string {
  const normalized = normalizeText(input)
    .replace(/\n{3,}/g, (match) => '\n'.repeat(Math.min(match.length, MAX_CONSECUTIVE_NEWLINES)))
    .trim();
  return normalized.slice(0, MESSAGE_MAX_LENGTH);
}

/** Defensive strip for any place we render user content outside React text nodes. */
export function stripMarkup(input: string): string {
  return stripControlChars(input).replace(/<[^>]*>/g, '');
}

export function sanitizeName(input: string): string {
  return stripMarkup(input).replace(/\s+/g, ' ').trim().slice(0, 48);
}

export function safeSearchTerm(input: string): string {
  return stripControlChars(input).trim().slice(0, 64);
}

export { truncate };
