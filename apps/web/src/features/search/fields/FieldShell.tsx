// FieldShell: the shared label + helper + inline-error layout for one form field
// (Req 5.4, 5.5, 24.2).
//
// It owns the accessible wiring that every control (text input, combobox, select)
// needs identically:
//   - a <label> tied to the control by `htmlFor={inputId}` (Req 3.1, 24.2);
//   - an inline error below the control, prefixed "Error:", with a warning icon,
//     referenced from the control via aria-describedby (Req 5.4);
//   - helper text (e.g. "Not yet available for search.") also referenced via
//     aria-describedby so screen-reader users hear why a field is disabled (Req 3.5).
//
// The control itself is passed as a render prop so it can read the computed ids and
// set aria-describedby / aria-invalid consistently. describedBy lists the helper id
// first, then the error id when present, so both are announced.
import type { ReactNode } from 'react';

export interface FieldA11y {
  /** Value for the control's aria-describedby, or undefined when nothing to describe. */
  describedBy?: string;
  /** Value for the control's aria-invalid ("true" when errored, else undefined). */
  invalid?: 'true';
}

interface FieldShellProps {
  inputId: string;
  label: string;
  /** Inline validation message (without the "Error:" prefix). */
  error?: string;
  /** Static helper text (e.g. disabled-field explanation). */
  helper?: string;
  /** Render the control, given the ids/aria it must apply. */
  children: (a11y: FieldA11y) => ReactNode;
}

export function FieldShell({ inputId, label, error, helper, children }: FieldShellProps) {
  const errorId = `${inputId}-error`;
  const helperId = `${inputId}-helper`;

  // Order matters: helper first, then error, so assistive tech reads the reason a
  // field is disabled before any error. Only include ids that are actually present.
  const describedBy =
    [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </label>

      {children({ describedBy, invalid: error ? 'true' : undefined })}

      {helper && (
        <p id={helperId} className="text-xs text-text-2">
          {helper}
        </p>
      )}

      {error && (
        <p id={errorId} className="flex items-start gap-1 text-sm text-error">
          <span aria-hidden="true" className="font-semibold">
            ⚠
          </span>
          <span>
            <span className="font-semibold">Error:</span> {error}
          </span>
        </p>
      )}
    </div>
  );
}
