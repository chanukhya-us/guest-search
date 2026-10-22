// Shared control styling for form inputs (ihg-brand-ui: 44-48px tall, 1px #666
// border via border-border-strong, 4px radius, 2px navy focus outline from the
// global :focus-visible rule). Errored controls get a 2px error border.
//
// Kept as a string builder so TextField, the country combobox input and the
// member-type select all look identical and stay token-only (no hex, Req 23.1).

/** Base classes for a 48px-tall text/select control. */
const BASE =
  'h-12 w-full rounded-control border bg-surface px-3 text-base text-body ' +
  'transition-[border-color,box-shadow] duration-150 ' +
  'focus:shadow-[0_0_0_4px_var(--ihg-navy-50)] ' +
  'placeholder:text-muted disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted';

/** Interactive border feedback, only for valid, enabled controls (errors keep their red border). */
const VALID =
  'border-border-strong hover:border-navy focus:border-navy disabled:hover:border-border-strong';

/** Build the control class list, widening the border and colouring it on error (Req 5.4). */
export function controlClass(invalid: boolean): string {
  return `${BASE} ${invalid ? 'border-2 border-error' : VALID}`;
}
