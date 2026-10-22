// CountryComboBox: Country as a searchable, localized selection of ISO 3166-1 alpha-2
// countries (Req 3.3).
//
// Built on React Aria Components' ComboBox so a colleague can type to filter the long
// country list (that is what makes the selection "searchable", Req 3.3). The stored
// value is the alpha-2 code; labels come from Intl.DisplayNames (countryOptions.ts).
//
// Accessibility wiring mirrors the other fields: FieldShell renders the visible
// <label htmlFor={inputId}> and the inline error, and the combobox Input carries that
// id plus the aria-describedby / aria-invalid it is handed. The empty selection means
// "not supplied"; clearing the text resets the value to "".
import { Button, ComboBox, Input, ListBox, ListBoxItem, Popover } from 'react-aria-components';

import { controlClass } from './controlStyles.js';
import { FieldShell } from './FieldShell.js';
import type { CountryOption } from './countryOptions.js';

interface CountryComboBoxProps {
  inputId: string;
  label: string;
  options: readonly CountryOption[];
  /** Current alpha-2 code, or "" when nothing is selected. */
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error?: string;
}

export function CountryComboBox({
  inputId,
  label,
  options,
  value,
  onChange,
  onBlur,
  error,
}: CountryComboBoxProps) {
  return (
    <FieldShell inputId={inputId} label={label} error={error}>
      {({ describedBy, invalid }) => (
        <ComboBox
          aria-label={label}
          selectedKey={value === '' ? null : value}
          onSelectionChange={(key) => onChange(key === null ? '' : String(key))}
          onBlur={onBlur}
          allowsEmptyCollection
          menuTrigger="input"
          className="relative"
        >
          <div className="flex">
            <Input
              id={inputId}
              autoComplete="country"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="Search countries"
              className={controlClass(error !== undefined)}
            />
            <Button
              aria-label="Show countries"
              className="-ml-9 w-9 text-muted"
              // The toggle sits over the input's right edge; it opens the list.
            >
              <span aria-hidden="true">▾</span>
            </Button>
          </div>
          <Popover className="max-h-72 w-[var(--trigger-width)] overflow-auto rounded-control border border-border bg-surface shadow-panel">
            <ListBox className="p-1">
              {options.map((opt) => (
                <ListBoxItem
                  key={opt.code}
                  id={opt.code}
                  textValue={opt.label}
                  className="cursor-pointer rounded-control px-3 py-2 text-body data-[focused]:bg-navy-wash data-[selected]:font-semibold"
                >
                  {opt.label}
                </ListBoxItem>
              ))}
            </ListBox>
          </Popover>
        </ComboBox>
      )}
    </FieldShell>
  );
}
