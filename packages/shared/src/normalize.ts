// Pure text helpers used by the criteria schema (Req 4.2, 4.3).
//
// Pipeline: normalize first, then reject. The schema runs `normalizeText` in
// `z.preprocess` and then refines with `hasControlChars`.
//
// How whitespace handling and the control-character check interact:
// - JavaScript `\s` (and String.prototype.trim) includes characters that are
//   themselves Cc or Cf: TAB, LF, VT, FF, CR (Cc) and U+FEFF BOM (Cf). If trimming
//   and collapsing used them, a value such as "John\tSmith" or "Smith\n" would
//   come out clean and the Cc/Cf rule (Req 4.3) would never see the control
//   character.
// - So trimming and collapsing apply only to `\s` minus Cc/Cf: SPACE, NBSP,
//   U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F and U+3000.
// - Decision: TAB, CR, LF and the other Cc/Cf characters are kept as they are,
//   both inside the value and at its edges, so the schema rejects them. They are
//   not converted to spaces.

/** `\s` minus Unicode Cc and Cf, i.e. whitespace that is safe to trim and collapse. */
const SAFE_WHITESPACE_RUN = /[^\S\p{Cc}\p{Cf}]+/gu;

/** Single edge space left after collapsing. */
const EDGE_SPACE = /^ | $/g;

/** Any Unicode control (Cc) or format (Cf) character. Not global, so it keeps no `lastIndex` state. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/**
 * Normalizes a criteria value (Req 4.2): NFC, collapse internal whitespace
 * runs to one space, trim, and treat an empty result as "not supplied"
 * (`undefined`).
 *
 * NFC runs first, so the trim and collapse also cover any whitespace that
 * normalization produces. That keeps the function idempotent (design P9). For
 * every input the result is the same as trim → NFC → collapse.
 *
 * Non-string input (number, null, object…) is returned unchanged so that Zod
 * reports a type error instead of a coerced value being accepted.
 *
 * Cc/Cf characters (including TAB/CR/LF) are never removed or collapsed. See the
 * file header.
 */
export function normalizeText(v: string): string | undefined;
export function normalizeText(v: unknown): unknown;
export function normalizeText(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const out = v.normalize('NFC').replace(SAFE_WHITESPACE_RUN, ' ').replace(EDGE_SPACE, '');
  return out === '' ? undefined : out;
}

/** True if `s` contains any Unicode control (Cc) or format (Cf) character (Req 4.3). */
export function hasControlChars(s: string): boolean {
  return CONTROL_OR_FORMAT.test(s);
}
