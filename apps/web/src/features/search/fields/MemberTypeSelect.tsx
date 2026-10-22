// MemberTypeSelect: Member Type as a labelled selection whose options come from the
// UiConfig code set (Req 3.4, 4.9).
//
// A native <select> is used: it is fully keyboard- and screen-reader-accessible with
// a real <label>, needs no popup wiring, and renders every option as assertable DOM
// (the form tests check the options against config). An empty "Any" option is the
// default so a colleague can leave Member Type unset; its value is "" which the
// shared schema normalizes to "not supplied".
//
// The value is controlled by react-hook-form via Controller (value + onChange), so it
// participates in validation and Clear/reset like every other field.
import { controlClass } from './controlStyles.js';
import { FieldShell } from './FieldShell.js';

export interface MemberTypeOption {
  code: string;
  label: string;
}

interface MemberTypeSelectProps {
  inputId: string;
  label: string;
  options: readonly MemberTypeOption[];
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error?: string;
}

/** The empty option label; its value "" means "not supplied" after normalization. */
export const MEMBER_TYPE_ANY_LABEL = 'Any';

export function MemberTypeSelect({
  inputId,
  label,
  options,
  value,
  onChange,
  onBlur,
  error,
}: MemberTypeSelectProps) {
  return (
    <FieldShell inputId={inputId} label={label} error={error}>
      {({ describedBy, invalid }) => (
        <select
          id={inputId}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          className={controlClass(error !== undefined)}
        >
          <option value="">{MEMBER_TYPE_ANY_LABEL}</option>
          {options.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
