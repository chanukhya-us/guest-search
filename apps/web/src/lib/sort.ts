// Sort comparators for the results table (task 12.5, design.md "lib/sort.ts").
//
// The table sorts the current result set client-side (Req 15.5, 15.7). Two comparators:
//   - scoreCompare: numeric, with undefined scores always placed last, in service order
//     (stable). TanStack applies the direction, so this expresses the ascending order
//     "lower score first, undefined after all numbers"; desc flips it to "highest first,
//     undefined still last" via sortUndefined: 'last' on the column (design.md default
//     sort [{ id: 'score', desc: true }]).
//   - textCompare: locale-aware, case-insensitive string compare for name/city/country,
//     with empty values sorted last.
//
// These are plain (a, b) => number functions over the raw accessor values so they can be
// unit-tested directly and reused by the TanStack column `sortFn`.

/**
 * Compare two optional numbers ascending, treating undefined/NaN as "greater than" every
 * real number so they sort last in ascending order. TanStack's `sortUndefined: 'last'`
 * keeps them last in both directions; this comparator handles the numeric ordering only.
 */
export function scoreCompare(a: number | undefined, b: number | undefined): number {
  const av = typeof a === 'number' && !Number.isNaN(a) ? a : undefined;
  const bv = typeof b === 'number' && !Number.isNaN(b) ? b : undefined;
  if (av === undefined && bv === undefined) return 0;
  if (av === undefined) return 1;
  if (bv === undefined) return -1;
  return av - bv;
}

/** A shared locale collator (case/accent-insensitive) for name, city and country. */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Compare two optional strings with locale rules, empty/undefined sorted last. Used for
 * First Name, Last Name, City and Country columns (Req 15.7).
 */
export function textCompare(a: string | undefined, b: string | undefined): number {
  const av = a != null && a !== '' ? a : undefined;
  const bv = b != null && b !== '' ? b : undefined;
  if (av === undefined && bv === undefined) return 0;
  if (av === undefined) return 1;
  if (bv === undefined) return -1;
  return collator.compare(av, bv);
}
