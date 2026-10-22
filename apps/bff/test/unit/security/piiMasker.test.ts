// PII masking rules (task 8.3, Req 14.1–14.4). Example-based coverage of the exact format
// from design.md, the short-value rules (Req 14.3), Unicode phones/emails (i18n hardening),
// and the overarching safety invariant: a masked value never contains the raw value and
// never reveals more than the format permits.
import { describe, expect, it } from 'vitest';

import { MASK, maskEmail, maskPhone } from '../../../src/security/piiMasker.js';

describe('maskPhone (Req 14.1, 14.3)', () => {
  it('keeps only the last 4 digits behind the bullet prefix', () => {
    expect(maskPhone('+1 404 555 0101')).toBe('•••• 0101');
    expect(maskPhone('14045550101')).toBe('•••• 0101');
  });

  it('ignores separators and formatting when counting and slicing digits', () => {
    // (404) 555-0199 -> last four ASCII digits are 0199.
    expect(maskPhone('(404) 555-0199')).toBe('•••• 0199');
    expect(maskPhone('404.555.0147 ext')).toBe('•••• 0147');
  });

  it('masks the whole value when there are 4 or fewer digits (Req 14.3)', () => {
    expect(maskPhone('1234')).toBe(MASK);
    expect(maskPhone('12')).toBe(MASK);
    expect(maskPhone('')).toBe(MASK);
    expect(maskPhone('+   -')).toBe(MASK); // no digits at all
  });

  it('reveals exactly the last four digits for a long international number', () => {
    expect(maskPhone('+44 20 7946 0958')).toBe('•••• 0958');
  });

  it('treats non-ASCII (Arabic-Indic) digits as non-revealable and fully masks', () => {
    // U+0660–0669 are digits in Unicode but NOT matched by \D-stripping (ASCII \d only).
    // The deliberate, documented result is the fully-masked form — no script glyph leaks.
    const easternArabic = '\u0665\u0665\u0665\u0661\u0660\u0661\u0660\u0661'; // ٥٥٥١٠١٠١
    expect(maskPhone(easternArabic)).toBe(MASK);
  });

  it('never contains any digit other than the revealed last four', () => {
    const masked = maskPhone('18005551234');
    const digits = masked.replace(/\D/g, '');
    expect(digits).toBe('1234');
  });

  it('never returns the raw input', () => {
    for (const raw of ['+1 404 555 0101', '1234', '18005551234', '']) {
      expect(maskPhone(raw)).not.toBe(raw);
    }
  });
});

describe('maskEmail (Req 14.2, 14.3)', () => {
  it('reveals the first local char and the full domain', () => {
    expect(maskEmail('alex@example.test')).toBe('a•••@example.test');
    expect(maskEmail('jordan.smith@sub.example.test')).toBe('j•••@sub.example.test');
  });

  it('masks the whole local part when it is a single character (Req 14.3)', () => {
    expect(maskEmail('a@example.test')).toBe('•••@example.test');
  });

  it('masks an empty local part', () => {
    expect(maskEmail('@example.test')).toBe('•••@example.test');
  });

  it('splits on the LAST @ so the domain is correct for quoted locals', () => {
    // The local part contains an @; only the final @ separates the domain.
    expect(maskEmail('"a@b"@example.test')).toBe('"•••@example.test');
  });

  it('keeps the full domain verbatim, including Unicode/IDN domains', () => {
    expect(maskEmail('user@münchen.example')).toBe('u•••@münchen.example');
  });

  it('reveals the first code point whole for a non-ASCII local part', () => {
    // Leading astral character (emoji) must not be split into a lone surrogate.
    const masked = maskEmail('😀lex@example.test');
    expect(masked).toBe('😀•••@example.test');
    expect(masked.startsWith('😀')).toBe(true);
    expect(masked).not.toContain('\uFFFD');
  });

  it('reveals the first code point whole for a CJK local part', () => {
    expect(maskEmail('田中太郎@example.test')).toBe('田•••@example.test');
  });

  it('masks everything and emits no domain when there is no @', () => {
    expect(maskEmail('not-an-email')).toBe('•••');
  });

  it('never returns the raw input', () => {
    for (const raw of ['alex@example.test', 'a@example.test', 'not-an-email']) {
      expect(maskEmail(raw)).not.toBe(raw);
    }
  });

  it('reveals at most one character of the local part', () => {
    const masked = maskEmail('abcdefgh@example.test');
    const local = masked.slice(0, masked.lastIndexOf('@'));
    // Everything before the bullets is at most one code point.
    const revealed = local.replace(/•+$/u, '');
    expect(Array.from(revealed).length).toBeLessThanOrEqual(1);
  });
});
