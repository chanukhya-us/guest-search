// Per-field presentation metadata for the search form (Req 3.1, 3.2).
//
// The form renders the 12 criteria in the Req 3.2 order (which matches
// CRITERIA_FIELDS in @ihg-guest-search/shared). This table holds the visible
// label, the input id (`criteria-<field>`), the HTML autocomplete token and the
// input kind for each field. Keeping it in one place means SearchForm, the field
// controls and the ErrorSummary all agree on ids and labels.
import { CRITERIA_FIELDS, type CriteriaField } from '@ihg-guest-search/shared';

import { FIRST_NAME_INPUT_ID } from '../../../a11y/useShortcut.js';

/** How a field is rendered: a plain text box, the country combobox or the member-type select. */
export type FieldKind = 'text' | 'country' | 'memberType';

export interface FieldMeta {
  field: CriteriaField;
  /** Visible label text (Req 3.1). */
  label: string;
  /** The input element id; also the ErrorSummary link target (Req 5.3). */
  inputId: string;
  /** HTML autocomplete token (Req 3.1 "with autocomplete"). */
  autoComplete: string;
  kind: FieldKind;
  /** `type` attribute for text inputs (email/tel get the matching input type). */
  inputType?: 'text' | 'email' | 'tel';
  /**
   * True when the field is one of the address fields gated by a UiConfig feature
   * flag (Req 9.4): addressLine1, city, postalCode. addressLine2 is always disabled
   * (Req 3.5) and is handled by `alwaysDisabled`, not this flag.
   */
  featureFlag?: 'addressLine1' | 'city' | 'postalCode';
  /** True for Address Line 2, which has no request element and is always disabled (Req 3.5). */
  alwaysDisabled?: boolean;
}

/** The input id for a criteria field (e.g. "criteria-lastName"). */
export function inputIdFor(field: CriteriaField): string {
  return field === 'firstName' ? FIRST_NAME_INPUT_ID : `criteria-${field}`;
}

/** The per-field table, in Req 3.2 display order. */
export const FIELD_META: readonly FieldMeta[] = [
  { field: 'firstName', label: 'First name', autoComplete: 'given-name', kind: 'text' },
  { field: 'lastName', label: 'Last name', autoComplete: 'family-name', kind: 'text' },
  {
    field: 'email',
    label: 'Email',
    autoComplete: 'email',
    kind: 'text',
    inputType: 'email',
  },
  { field: 'phone', label: 'Phone', autoComplete: 'tel', kind: 'text', inputType: 'tel' },
  {
    field: 'loyaltyMemberId',
    label: 'Loyalty member ID',
    autoComplete: 'off',
    kind: 'text',
  },
  { field: 'memberType', label: 'Member type', autoComplete: 'off', kind: 'memberType' },
  { field: 'country', label: 'Country', autoComplete: 'country', kind: 'country' },
  {
    field: 'stateOrRegion',
    label: 'State or region',
    autoComplete: 'address-level1',
    kind: 'text',
  },
  {
    field: 'addressLine1',
    label: 'Address line 1',
    autoComplete: 'address-line1',
    kind: 'text',
    featureFlag: 'addressLine1',
  },
  {
    field: 'addressLine2',
    label: 'Address line 2',
    autoComplete: 'address-line2',
    kind: 'text',
    alwaysDisabled: true,
  },
  {
    field: 'city',
    label: 'City',
    autoComplete: 'address-level2',
    kind: 'text',
    featureFlag: 'city',
  },
  {
    field: 'postalCode',
    label: 'Postal code',
    autoComplete: 'postal-code',
    kind: 'text',
    featureFlag: 'postalCode',
  },
].map((m) => ({ ...m, inputId: inputIdFor(m.field as CriteriaField) })) as readonly FieldMeta[];

// Fail fast (in tests) if the meta table ever drifts out of sync with the shared
// field list. Both must be the same 12 fields in the same order.
if (
  FIELD_META.length !== CRITERIA_FIELDS.length ||
  FIELD_META.some((m, i) => m.field !== CRITERIA_FIELDS[i])
) {
  throw new Error('FIELD_META must match CRITERIA_FIELDS exactly, in order.');
}

/** Helper text shown on every disabled field (Req 3.5, 9.4). */
export const NOT_YET_SUPPORTED = 'Not yet available for search.';
