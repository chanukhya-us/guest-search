// SearchForm tests (task 12.3). These exercise the real shared schema (no mock), so
// client/server validation parity is proven: the same createCriteriaSchema that the
// BFF uses drives the resolver here.
//
// Interactions use fireEvent (the project convention; user-event is not a dependency).
// The form reads uncontrolled text inputs on submit and controlled values for the
// member-type select and country combobox.
import type { GuestSearchQuery, UiConfig } from '@ihg-guest-search/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StatusRegionProvider } from '../../src/a11y/StatusRegion';
import { FIRST_NAME_INPUT_ID } from '../../src/a11y/useShortcut';
import { useShortcut } from '../../src/a11y/useShortcut';
import { SearchForm, type ServerFieldError } from '../../src/features/search/SearchForm';

const CONFIG: UiConfig = {
  scoreBands: { high: 90, medium: 70 },
  memberTypes: [
    { code: 'PC', label: 'IHG One Rewards Platinum' },
    { code: 'DC', label: 'IHG One Rewards Diamond' },
  ],
  // All address flags off: addressLine1, city and postalCode are disabled (Req 9.4).
  features: { addressLine1: false, city: false, postalCode: false },
  authMode: 'dev',
};

/** Render the form inside the StatusRegion provider it depends on. */
function renderForm(props?: {
  submitting?: boolean;
  serverErrors?: ServerFieldError[];
  withShortcut?: boolean;
}) {
  const onSearch = vi.fn<(c: GuestSearchQuery) => void>();

  function Harness() {
    if (props?.withShortcut) useShortcut();
    return (
      <SearchForm
        config={CONFIG}
        onSearch={onSearch}
        submitting={props?.submitting}
        serverErrors={props?.serverErrors}
      />
    );
  }

  const utils = render(
    <StatusRegionProvider>
      <Harness />
    </StatusRegionProvider>,
  );
  return { ...utils, onSearch };
}

function firstNameInput(): HTMLInputElement {
  return document.getElementById(FIRST_NAME_INPUT_ID) as HTMLInputElement;
}

function submitForm(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

describe('SearchForm — fields', () => {
  it('renders a labelled control for all 12 criteria in Req 3.2 order', () => {
    renderForm();
    const labels = [
      'First name',
      'Last name',
      'Email',
      'Phone',
      'Loyalty member ID',
      'Member type',
      'Country',
      'State or region',
      'Address line 1',
      'Address line 2',
      'City',
      'Postal code',
    ];
    for (const label of labels) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // First Name carries the id the "/" shortcut targets.
    expect(screen.getByLabelText('First name')).toHaveAttribute('id', FIRST_NAME_INPUT_ID);
  });

  it('disables feature-flagged address fields and Address Line 2, each with an explanation', () => {
    renderForm();
    for (const label of ['Address line 1', 'City', 'Postal code', 'Address line 2']) {
      const input = screen.getByLabelText(label);
      expect(input).toBeDisabled();
      // The helper text is associated through aria-describedby.
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const helper = document.getElementById(describedBy as string);
      expect(helper).toHaveTextContent(/not yet available/i);
    }
  });

  it('enables an address field when its feature flag is on', () => {
    const config: UiConfig = { ...CONFIG, features: { ...CONFIG.features, city: true } };
    render(
      <StatusRegionProvider>
        <SearchForm config={config} onSearch={vi.fn()} />
      </StatusRegionProvider>,
    );
    expect(screen.getByLabelText('City')).toBeEnabled();
    expect(screen.getByLabelText('Address line 1')).toBeDisabled();
  });

  it('builds Member Type options from config with an empty "Any" default', () => {
    renderForm();
    const select = screen.getByLabelText('Member type') as HTMLSelectElement;
    const options = within(select).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Any');
    expect(options[0]).toHaveValue('');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'PC', 'DC']);
    expect(options[1]).toHaveTextContent('IHG One Rewards Platinum');
  });

  it('renders Country as a searchable combobox of ISO countries', () => {
    renderForm();
    const combo = screen.getByLabelText('Country');
    expect(combo).toHaveAttribute('role', 'combobox');
  });
});

describe('SearchForm — validation', () => {
  it('blocks an all-empty submit with the NO_CRITERIA form-level message and no callback', async () => {
    const { onSearch } = renderForm();
    submitForm();

    // The form-level message appears in the summary and no search is emitted.
    expect(
      await screen.findByText(/please enter at least one search criterion/i),
    ).toBeInTheDocument();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('shows the schema email message inline and sets aria-invalid on the field', async () => {
    renderForm();
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    submitForm();

    const email = screen.getByLabelText('Email');
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    // The exact shared-schema message.
    const describedBy = email.getAttribute('aria-describedby') as string;
    const errorNode = document.getElementById(`${email.id}-error`);
    expect(describedBy).toContain(`${email.id}-error`);
    expect(errorNode).toHaveTextContent('Enter a valid email address');
  });

  it('moves focus to the ErrorSummary and its links focus the related input', async () => {
    renderForm();
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'bad' } });
    submitForm();

    const heading = await screen.findByRole('heading', { name: /problem/i });
    await waitFor(() => expect(heading).toHaveFocus());

    const link = screen.getByRole('link', { name: /email/i });
    fireEvent.click(link);
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });
});

describe('SearchForm — submit and clear', () => {
  it('emits the normalized criteria for a valid single-field search', async () => {
    const { onSearch } = renderForm();
    fireEvent.input(firstNameInput(), { target: { value: '  Alex  ' } });
    submitForm();

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    // Normalized: trimmed, and only the supplied field is present (disabled/empty omitted).
    expect(onSearch).toHaveBeenCalledWith({ firstName: 'Alex' });
  });

  it('does not include a disabled field in the submitted criteria', async () => {
    const { onSearch } = renderForm();
    fireEvent.input(firstNameInput(), { target: { value: 'Alex' } });
    // Even if a disabled field somehow holds a value, it must not reach onSearch.
    const city = screen.getByLabelText('City') as HTMLInputElement;
    fireEvent.input(city, { target: { value: 'Atlanta' } });
    submitForm();

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    const criteria = onSearch.mock.lastCall?.[0];
    expect(criteria?.city).toBeUndefined();
    expect(criteria).toEqual({ firstName: 'Alex' });
  });

  it('Clear resets fields, errors and focuses First Name', async () => {
    const { onSearch } = renderForm();
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'bad' } });
    submitForm();
    await screen.findByRole('heading', { name: /problem/i });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.queryByRole('heading', { name: /problem/i })).not.toBeInTheDocument();
    expect(firstNameInput()).toHaveFocus();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('disables the actions and shows "Searching…" while submitting', () => {
    renderForm({ submitting: true });
    const search = screen.getByRole('button', { name: 'Searching…' });
    expect(search).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });
});

describe('SearchForm — server errors (Req 5.7)', () => {
  it('maps a server field error into the inline + summary UI', async () => {
    const serverErrors: ServerFieldError[] = [
      { field: 'postalCode', message: 'This field is not yet supported for search.' },
    ];
    renderForm({ serverErrors });

    expect(
      await screen.findByText('This field is not yet supported for search.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Postal code')).toHaveAttribute('aria-invalid', 'true');
  });

  it('maps a server NO_CRITERIA root error into the summary', async () => {
    const serverErrors: ServerFieldError[] = [
      { field: 'root', message: 'Please enter at least one search criterion.' },
    ];
    renderForm({ serverErrors });
    expect(
      await screen.findByRole('link', { name: /search criteria.*at least one/i }),
    ).toBeInTheDocument();
  });
});

describe('SearchForm — "/" shortcut (Req 24.10)', () => {
  it('focuses First Name when "/" is pressed outside a text field', () => {
    renderForm({ withShortcut: true });
    // Focus a non-text element (the Search button) first.
    const search = screen.getByRole('button', { name: 'Search' });
    search.focus();
    fireEvent.keyDown(document, { key: '/' });
    expect(firstNameInput()).toHaveFocus();
  });
});
