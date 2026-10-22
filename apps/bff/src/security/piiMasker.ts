/**
 * PII masking (design.md "PiiMasker", Req 14.1–14.4).
 *
 * Phones and emails are the only contact values shown masked in a search response. Names,
 * addresses, Enterprise ID, Loyalty Member ID, Member Type and Membership Status are never
 * masked (Req 14.4) and are not touched here. Masking runs *after* primary selection, so
 * `pickPrimary` always chooses from the real, unmasked data (design.md step order).
 *
 * The functions are pure and deterministic: the same input always yields the same masked
 * string, with no randomness and no dependence on wall-clock or locale. They never return
 * the raw value — every branch drops characters (Req 14.1–14.3). The unmasked originals live
 * only in the `RevealStore` and are released solely through the reveal flow.
 *
 * Masking format (exactly as design.md specifies):
 *   maskPhone: digits = n.replace(/\D/g, ''); len > 4 ? `•••• ${last4}` : `••••`
 *   maskEmail: [local, domain] at the last '@'; local.len > 1 ? `${local[0]}•••@${domain}`
 *                                                            : `•••@${domain}`
 *
 * i18n note (reviewed with the i18n guidance):
 *   - "last 4 digits" and "first character of the local part" are defined on the characters a
 *     colleague reads, so the mask must survive non-ASCII input without corrupting it.
 *   - Phones: design's `\D` (ASCII-digit) class is kept deliberately. International numbers are
 *     stored with ASCII digits after formatting; Unicode digit scripts (e.g. Arabic-Indic
 *     U+0660–0669) are intentionally NOT treated as revealable last-4 digits, so they collapse
 *     to the fully-masked `••••` form rather than leaking script-specific glyphs. This is the
 *     safe-by-default choice and is documented, not accidental.
 *   - Email local part: the "first character" is taken by Unicode code point (`Array.from`),
 *     never by UTF-16 index, so a leading astral character or a character outside the BMP is
 *     revealed whole and never split into a lone surrogate (which would render as U+FFFD and
 *     could itself be a subtle info-leak / corruption). For plain ASCII locals this is
 *     byte-for-byte identical to design's `local[0]`.
 *   - The domain is emitted verbatim (Req 14.2 requires the *full* domain); IDN/Unicode domains
 *     pass through unchanged. No case folding is applied (that would be a locale-dependent
 *     transform on data we must not alter).
 */

/** The mask glyph used throughout: U+2022 BULLET, repeated four times as the prefix. */
export const MASK = '••••';

/**
 * Mask a phone number: keep only the last 4 ASCII digits behind the bullet prefix.
 *
 * - 5+ ASCII digits  -> `•••• 1234` (space, then the final four digits in order)
 * - 4 or fewer digits -> `••••` (Req 14.3: too few digits to safely reveal any)
 *
 * Non-digit characters (spaces, `+`, `-`, `(`, `)`, Unicode separators) are ignored when
 * counting and are never echoed, so no part of the original formatting leaks.
 */
export function maskPhone(n: string): string {
  const digits = n.replace(/\D/g, '');
  if (digits.length > 4) {
    return `${MASK} ${digits.slice(-4)}`;
  }
  return MASK;
}

/**
 * Mask an email: reveal the first code point of the local part and the full domain.
 *
 * - local part length > 1 -> `a•••@example.test`
 * - local part length <= 1 (or empty) -> `•••@example.test` (Req 14.3)
 *
 * The split is on the LAST '@' so quoted/edge locals keep the correct domain. "Length" and
 * "first character" are measured in Unicode code points so non-ASCII locals are never split
 * mid-surrogate. The domain is returned exactly as received.
 *
 * Defensive edge case: a string with no '@' is not a valid address and has no domain. Rather
 * than echo the whole string as a "domain" (which would leak it), the entire value is treated
 * as the local part and collapsed to `•••` with no domain segment.
 */
export function maskEmail(e: string): string {
  const at = e.lastIndexOf('@');
  if (at < 0) {
    // No '@': nothing is a safe-to-show domain, so reveal nothing.
    return '•••';
  }
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);

  // Code-point-aware first character; empty array when the local part is empty.
  const codePoints = Array.from(local);
  if (codePoints.length > 1) {
    return `${codePoints[0] ?? ''}•••@${domain}`;
  }
  return `•••@${domain}`;
}
