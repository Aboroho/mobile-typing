import { describe, expect, it } from 'vitest';
import { MESSAGE_MAX_LENGTH } from '@mt/types';
import { safeSearchTerm, sanitizeMessageText, sanitizeName, stripMarkup } from '@/lib/domain/sanitize';

describe('sanitizeMessageText', () => {
  it('removes control characters', () => {
    expect(sanitizeMessageText('hello\u0000world')).toBe('helloworld');
    expect(sanitizeMessageText('bell\u0007here')).toBe('bellhere');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeMessageText('   hello   ')).toBe('hello');
    expect(sanitizeMessageText('\n\nhello\n')).toBe('hello');
  });

  it('keeps newlines and tabs', () => {
    expect(sanitizeMessageText('line one\nline two\ttabbed')).toBe('line one\nline two\ttabbed');
  });

  it('bounds runs of blank lines', () => {
    expect(sanitizeMessageText('a\n\n\n\n\n\n\n\n\n\n\n\nb').split('\n').length).toBeLessThanOrEqual(10);
  });

  it('caps the stored length', () => {
    expect(sanitizeMessageText('x'.repeat(MESSAGE_MAX_LENGTH + 500)).length).toBe(MESSAGE_MAX_LENGTH);
  });

  it('normalises unicode so visually identical text stores identically', () => {
    expect(sanitizeMessageText('\u00e9')).toBe(sanitizeMessageText('e\u0301'));
  });
});

describe('stripMarkup', () => {
  it('removes tags and control characters', () => {
    expect(stripMarkup('<img src=x onerror=alert(1)>hi')).toBe('hi');
    expect(stripMarkup('a\u0007b')).toBe('ab');
  });
});

describe('sanitizeName', () => {
  it('collapses whitespace, strips markup and caps the length', () => {
    expect(sanitizeName('  Ada    <b>Lovelace</b>  ')).toBe('Ada Lovelace');
    expect(sanitizeName('x'.repeat(120)).length).toBe(48);
  });
});

describe('safeSearchTerm', () => {
  it('trims and caps the term', () => {
    expect(safeSearchTerm('   ada   ')).toBe('ada');
    expect(safeSearchTerm('x'.repeat(200)).length).toBe(64);
  });

  it('removes control characters but leaves punctuation for the caller to handle', () => {
    expect(safeSearchTerm('a\u0000b')).toBe('ab');
  });
});
