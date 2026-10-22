// Public entry point for @ihg-guest-search/shared.
export { CRITERIA_FIELDS, defaultLimits, type CriteriaField } from './criteria.js';
export { hasControlChars, normalizeText } from './normalize.js';
export {
  createCriteriaSchema,
  defaultSchemaConfig,
  isNoCriteriaError,
  MESSAGES,
  NO_CRITERIA_MESSAGE,
  type GuestSearchInput,
  type GuestSearchQuery,
  type SchemaConfig,
} from './schema.js';
export type {
  AuthMode,
  ErrorResponse,
  GuestAddress,
  GuestEmail,
  GuestMembership,
  GuestPhone,
  GuestSearchResponse,
  GuestSearchResult,
  GuestSummary,
  MeResponse,
  RevealResponse,
  UiConfig,
} from './domain.js';
export { ERROR_CATALOG, ERROR_CODES, type ErrorCatalogEntry, type ErrorCode } from './errors.js';
export { pickPrimary } from './primary.js';
export { ROLES, type Role } from './roles.js';
