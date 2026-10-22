// Criteria field names and the single limits table (Req 3.2, 4.12).

/** The 12 search criteria, in the order the form displays them (Req 3.2). */
export const CRITERIA_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'loyaltyMemberId',
  'memberType',
  'country',
  'stateOrRegion',
  'addressLine1',
  'addressLine2',
  'city',
  'postalCode',
] as const;

export type CriteriaField = (typeof CRITERIA_FIELDS)[number];

/**
 * Maximum length (UTF-16 code units, after normalization) for each field. This is
 * the only place field lengths are defined (Req 4.12). The schema reads it through
 * `SchemaConfig.limits`.
 */
// TODO(B1): replace with XSD limits. These are placeholders until the WSDL/XSD arrives.
export const defaultLimits: Readonly<Record<CriteriaField, number>> = Object.freeze({
  firstName: 50,
  lastName: 50,
  email: 254, // Req 4.6 fixes 254 independently of the XSD.
  phone: 25,
  loyaltyMemberId: 20, // Raw input before spaces and hyphens are stripped. The pattern enforces 9 digits.
  memberType: 20, // Must fit every configured code, including the PLACEHOLDER default.
  country: 2,
  stateOrRegion: 50,
  addressLine1: 100,
  addressLine2: 100,
  city: 50,
  postalCode: 20,
});
