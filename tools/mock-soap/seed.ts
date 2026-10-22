/**
 * Synthetic guest seed for the local Node mock SOAP server (task 13.1).
 *
 * DEV TOOLING ONLY. This data never ships in the production build and is excluded from
 * coverage. Every value is synthetic per the project's fixture conventions:
 *   - enterprise IDs in 9000000xx
 *   - phones `+1 404 555 01xx`
 *   - emails `@example.test`
 * No real guest ever appears here.
 *
 * The file uses erasable TypeScript only (no enums, no parameter properties, no namespaces)
 * so it runs under `node --experimental-strip-types` with zero dependencies, matching the
 * `scripts/gen-fixtures.ts` pattern.
 */

/** One synthetic guest. Shapes the fields the mock can filter on and render. */
export interface SeedGuest {
  /** Enterprise ID, 9000000xx. Rendered into initiateGuest/enterpriseId. */
  readonly enterpriseId: string;
  readonly firstName: string;
  readonly lastName: string;
  /** `+1 404 555 01xx`. */
  readonly phone: string;
  /** `@example.test`. */
  readonly email: string;
  readonly city: string;
  /** Two-letter state/region, matched against the request `region1`. */
  readonly stateOrRegion: string;
  /** ISO 3166-1 alpha-2 country, matched against the request `country`. */
  readonly country: string;
  /** Membership programme code (matched against request membership/@code, memberType). */
  readonly memberType: string;
  /** Membership ID (matched against request membership/@value, loyaltyMemberId). */
  readonly memberId: string;
  readonly membershipStatus: string;
  /** Relevance score 0..100; results sort by this, descending. */
  readonly score: number;
  readonly gender: string;
  readonly status: string;
}

// ---------------------------------------------------------------------------------------
// Deterministic generation. No clock, no randomness: the seed is identical on every run,
// so tests and demos are reproducible.

const FIRST_NAMES = [
  'Avery',
  'Blake',
  'Casey',
  'Devon',
  'Emerson',
  'Finley',
  'Gray',
  'Harper',
  'Indigo',
  'Jordan',
  'Kai',
  'Logan',
  'Morgan',
  'Noa',
  'Oakley',
  'Parker',
  'Quinn',
  'Riley',
  'Sawyer',
  'Tatum',
] as const;

const LAST_NAMES = [
  'Anderson',
  'Brooks',
  'Carter',
  'Diaz',
  'Evans',
  'Foster',
  'Garcia',
  'Hughes',
  'Ibarra',
  'Johnson',
  'Khan',
  'Lopez',
  'Martin',
  'Nguyen',
  'Owens',
  'Patel',
  'Quintero',
  'Reed',
  'Singh',
  'Turner',
] as const;

/** City, state and country triples so filters by region/country return realistic groups. */
const PLACES = [
  { city: 'Atlanta', stateOrRegion: 'GA', country: 'US' },
  { city: 'Denver', stateOrRegion: 'CO', country: 'US' },
  { city: 'Austin', stateOrRegion: 'TX', country: 'US' },
  { city: 'Seattle', stateOrRegion: 'WA', country: 'US' },
  { city: 'Chicago', stateOrRegion: 'IL', country: 'US' },
  { city: 'Toronto', stateOrRegion: 'ON', country: 'CA' },
  { city: 'Vancouver', stateOrRegion: 'BC', country: 'CA' },
  { city: 'London', stateOrRegion: 'ENG', country: 'GB' },
  { city: 'Manchester', stateOrRegion: 'ENG', country: 'GB' },
  { city: 'Sydney', stateOrRegion: 'NSW', country: 'AU' },
] as const;

const MEMBER_TYPES = ['PLACEHOLDER', 'REWARDS', 'BUSINESS'] as const;
const MEMBER_STATUSES = ['ACTIVE', 'INACTIVE', 'PENDING'] as const;
const GENDERS = ['F', 'M', 'U'] as const;

/** Pad a 1..99 index to two digits (keeps IDs in 9000000xx, phones in 555 01xx). */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Pick from a non-empty readonly array by modular index (total determinism). */
function pick<T>(arr: readonly T[], i: number): T {
  // arr is always one of the non-empty constants above.
  return arr[i % arr.length] as T;
}

/** How many guests the seed holds (task asks for ~60). */
export const SEED_SIZE = 60;

/** Build guest `i` (1-based). Pure: a function of `i` only. */
function makeGuest(i: number): SeedGuest {
  const nn = pad2(i);
  const place = pick(PLACES, i - 1);
  return {
    enterpriseId: `9000000${nn}`,
    firstName: pick(FIRST_NAMES, i - 1),
    lastName: pick(LAST_NAMES, (i * 7 - 1) % LAST_NAMES.length),
    phone: `+1 404 555 01${nn}`,
    email: `${pick(FIRST_NAMES, i - 1).toLowerCase()}.${pick(LAST_NAMES, (i * 7 - 1) % LAST_NAMES.length).toLowerCase()}${nn}@example.test`,
    city: place.city,
    stateOrRegion: place.stateOrRegion,
    country: place.country,
    memberType: pick(MEMBER_TYPES, i - 1),
    memberId: `9000000${nn}`,
    membershipStatus: pick(MEMBER_STATUSES, i - 1),
    // Distinct, descending scores so sort order is unambiguous: 99.5, 99.0, ... 70.0.
    score: Number((100 - i * 0.5).toFixed(1)),
    gender: pick(GENDERS, i - 1),
    status: 'A',
  };
}

/** The frozen synthetic seed (SEED_SIZE guests). */
export const SEED: readonly SeedGuest[] = Object.freeze(
  Array.from({ length: SEED_SIZE }, (_, k) => makeGuest(k + 1)),
);
