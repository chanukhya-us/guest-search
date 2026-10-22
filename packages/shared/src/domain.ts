// Normalized domain models and API response shapes (design.md "packages/shared").
import type { CriteriaField } from './criteria.js';
import type { ErrorCode } from './errors.js';

export interface GuestPhone {
  number: string;
  type?: string;
  location?: string;
  profileDefault?: boolean;
}

export interface GuestEmail {
  address: string;
  profileDefault?: boolean;
}

export interface GuestAddress {
  line1?: string;
  line2?: string;
  city?: string;
  stateOrRegion?: string;
  postalCode?: string;
  country?: string;
  locationCode?: string;
  profileDefault?: boolean;
}

export interface GuestMembership {
  memberId?: string;
  memberType?: string;
  status?: string;
}

export interface GuestSearchResult {
  enterpriseId: string;
  score?: number;
  status?: string;
  gender?: string;
  firstName?: string;
  lastName?: string;
  addresses: GuestAddress[];
  phones: GuestPhone[];
  emails: GuestEmail[];
  memberships: GuestMembership[];
}

/** API shape: result (phones/emails masked) + primaries + reveal token. */
export interface GuestSummary {
  guest: GuestSearchResult;
  primary: {
    address?: GuestAddress;
    phone?: GuestPhone;
    email?: GuestEmail;
    membership?: GuestMembership;
  };
  revealToken?: string;
}

export interface GuestSearchResponse {
  requestId: string;
  success: true;
  totalResults: number;
  limit: number;
  results: GuestSummary[];
}

export interface RevealResponse {
  requestId: string;
  phones: GuestPhone[];
  emails: GuestEmail[];
}

export interface ErrorResponse {
  requestId: string;
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    fields?: { field: CriteriaField | 'root'; message: string }[];
  };
}

export type AuthMode = 'dev' | 'oidc';

export interface MeResponse {
  displayName: string;
  roles: string[];
  authMode: AuthMode;
}

/**
 * Non-sensitive UI configuration served by GET /api/v1/config (Req 3.4, 3.5, 15.6).
 * Not spelled out in design.md; derived from its description: score-band thresholds,
 * member-type code set, address feature flags (Req 9.4) and authMode.
 */
export interface UiConfig {
  scoreBands: { high: number; medium: number };
  memberTypes: { code: string; label: string }[];
  features: { addressLine1: boolean; city: boolean; postalCode: boolean };
  authMode: AuthMode;
}
