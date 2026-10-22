// TextField: a labelled text/email/tel input wired into react-hook-form (Req 3.1).
//
// It spreads a RHF `register(...)` result onto a native <input>, so values are
// uncontrolled and submit reads them straight from the DOM. The FieldShell provides
// the label, helper and inline error; this component only renders the input and
// applies the aria-describedby / aria-invalid it is handed, plus the shared styling.
import type { UseFormRegisterReturn } from 'react-hook-form';

import { controlClass } from './controlStyles.js';
import { FieldShell } from './FieldShell.js';

interface TextFieldProps {
  inputId: string;
  label: string;
  autoComplete: string;
  type?: 'text' | 'email' | 'tel';
  disabled?: boolean;
  helper?: string;
  error?: string;
  /** Result of react-hook-form register(field). */
  registration: UseFormRegisterReturn;
}

export function TextField({
  inputId,
  label,
  autoComplete,
  type = 'text',
  disabled = false,
  helper,
  error,
  registration,
}: TextFieldProps) {
  return (
    <FieldShell inputId={inputId} label={label} helper={helper} error={error}>
      {({ describedBy, invalid }) => (
        <input
          id={inputId}
          type={type}
          autoComplete={autoComplete}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          className={controlClass(error !== undefined)}
          {...registration}
        />
      )}
    </FieldShell>
  );
}
