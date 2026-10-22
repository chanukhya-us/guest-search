// CountryComboBox tests (task 12.8 gap-fill, Req 3.3).
//
// The combobox stores the ISO alpha-2 CODE but displays the localized label, and an
// empty selection means "not supplied". searchForm.test.tsx only asserts the control
// renders with role=combobox; these pin the value mapping that Req 3.3 depends on:
//   - selecting an option reports its code (not its label) to onChange;
//   - a pre-selected code renders its label in the input;
//   - the field is labelled and wired for the accessible describedBy/invalid plumbing.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CountryComboBox } from '../../src/features/search/fields/CountryComboBox';
import type { CountryOption } from '../../src/features/search/fields/countryOptions';

const OPTIONS: CountryOption[] = [
  { code: 'US', label: 'United States' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'FR', label: 'France' },
];

function renderCombo(props?: { value?: string; onChange?: (v: string) => void }) {
  const onChange = props?.onChange ?? vi.fn();
  render(
    <CountryComboBox
      inputId="criteria-country"
      label="Country"
      options={OPTIONS}
      value={props?.value ?? ''}
      onChange={onChange}
      onBlur={vi.fn()}
    />,
  );
  return { onChange };
}

describe('CountryComboBox', () => {
  it('renders a labelled combobox wired to the field id', () => {
    renderCombo();
    const input = screen.getByLabelText('Country');
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('id', 'criteria-country');
    expect(input).toHaveAttribute('autocomplete', 'country');
  });

  it('reports the selected option CODE (not its label) to onChange', async () => {
    const { onChange } = renderCombo();

    // Open the list via the toggle button, then pick "France".
    fireEvent.click(screen.getByRole('button', { name: /show countries/i }));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: 'France' }));

    // The reported value is the alpha-2 code, never the display label (Req 3.3). The
    // input's displayed text is driven by the parent via the controlled `value` prop,
    // which the "pre-selected code" test below covers.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('FR'));
    expect(onChange).not.toHaveBeenCalledWith('France');
  });

  it('renders the label for a pre-selected code', () => {
    renderCombo({ value: 'GB' });
    expect(screen.getByLabelText('Country')).toHaveValue('United Kingdom');
  });

  it('surfaces the inline error and marks the input invalid', () => {
    render(
      <CountryComboBox
        inputId="criteria-country"
        label="Country"
        options={OPTIONS}
        value=""
        onChange={vi.fn()}
        onBlur={vi.fn()}
        error="Enter a valid country"
      />,
    );
    const input = screen.getByLabelText('Country');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a valid country')).toBeInTheDocument();
  });
});
