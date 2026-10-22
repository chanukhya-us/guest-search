// Criteria schema factory shared by the web app and the BFF (Req 4).
//
// Every field is: normalize (z.preprocess(normalizeText)) → reject Cc/Cf →
// max length from cfg.limits → field-specific rule. A value that normalizes to
// `undefined` is "not supplied" and passes the field (all fields are optional).
//
// Decisions:
// - Root "at least one" (Req 4.4, 4.5) is a refine on the strict object with
//   `path: []`. It runs on the normalized output, so whitespace-only values do
//   not count. Its `when` makes it run only when no field or unrecognized-key
//   issue exists, so the root issue only ever appears on its own. This is
//   deliberate: a field error means a value was supplied, and an unknown key is a
//   VALIDATION_ERROR (Req 4.13). The BFF maps "exactly one issue and it is the
//   root issue" to NO_CRITERIA (see `isNoCriteriaError`), everything else to
//   VALIDATION_ERROR.
// - Country accepts ASCII letters in either case and outputs uppercase. Req 4.11
//   forbids case changes only for names, addresses, emails and phones. The ASCII
//   check runs before uppercasing, so "ß" (→ "SS") or "ı" (→ "I") cannot sneak
//   into a valid code.
// - i18n-iso-countries is used only for `isValid`, which needs no locale data.
//   Its package "browser" field points at the locale-free entry, so the web
//   bundle stays small. Never call `registerLocale` here.
// - Names and addresses accept any script and combining marks (Req 4.3) and are
//   output exactly as normalized (Req 4.11).
import countries from 'i18n-iso-countries';
import { z } from 'zod';

import { CRITERIA_FIELDS, defaultLimits, type CriteriaField } from './criteria.js';
import { hasControlChars, normalizeText } from './normalize.js';

export interface SchemaConfig {
  /** Max length per field, after normalization (Req 4.12). */
  limits: Readonly<Record<CriteriaField, number>>;
  /** Applied to Loyalty Member ID after spaces and hyphens are removed (Req 4.8). */
  memberIdPattern: RegExp;
  /** Allowed Member Type codes (Req 3.4, 4.9). */
  memberTypes: readonly { code: string; label: string }[];
}

/** What a client may send: any subset of the 12 criteria, as strings. */
export type GuestSearchInput = { [K in CriteriaField]?: string };
/** What the schema returns: normalized values; absent means "not supplied". */
export type GuestSearchQuery = { [K in CriteriaField]?: string };

export const NO_CRITERIA_MESSAGE = 'Please enter at least one search criterion.';
export const MESSAGES = {
  notText: 'Enter text',
  controlChars: 'Remove control or formatting characters',
  tooLong: (max: number) => `Must be ${String(max)} characters or fewer`,
  email: 'Enter a valid email address',
  country: 'Select a valid country',
  memberId: 'Enter a valid loyalty member ID',
  memberType: 'Select a valid member type',
} as const;

/** Req 4.6 fixes 254 regardless of the limits table. */
const EMAIL_MAX = 254;
const ASCII_ALPHA2 = /^[A-Za-z]{2}$/;
const MEMBER_ID_SEPARATORS = /[ -]/g;

// TODO(B4): replace the placeholder with the supplied Member Type code set
// (matches UI_MEMBER_TYPES in .env.example).
export const defaultSchemaConfig: SchemaConfig = Object.freeze({
  limits: defaultLimits,
  memberIdPattern: /^\d{9}$/,
  memberTypes: Object.freeze([
    Object.freeze({ code: 'PLACEHOLDER', label: 'Placeholder member type' }),
  ]),
});

/** Normalized string with the Cc/Cf rule and a max length; `message` overrides both messages. */
function text(max: number, message?: string) {
  return z
    .string({ error: MESSAGES.notText })
    .refine((s) => !hasControlChars(s), { error: message ?? MESSAGES.controlChars, abort: true })
    .max(max, { error: message ?? MESSAGES.tooLong(max), abort: true });
}

function field<T extends z.ZodType>(inner: T) {
  return z.preprocess(normalizeText, inner.optional());
}

export function createCriteriaSchema(
  cfg: SchemaConfig,
): z.ZodType<GuestSearchQuery, GuestSearchInput> {
  const { limits } = cfg;
  const memberTypeCodes = new Set(cfg.memberTypes.map((t) => t.code));
  // Copy without g/y flags so `test` keeps no lastIndex state between parses.
  const memberIdPattern = new RegExp(
    cfg.memberIdPattern.source,
    cfg.memberIdPattern.flags.replace(/[gy]/g, ''),
  );

  const plain = (f: CriteriaField) => field(text(limits[f]));

  const schema = z
    .strictObject({
      firstName: plain('firstName'),
      lastName: plain('lastName'),
      email: field(
        text(Math.min(limits.email, EMAIL_MAX), MESSAGES.email).regex(z.regexes.html5Email, {
          error: MESSAGES.email,
        }),
      ),
      phone: plain('phone'),
      loyaltyMemberId: field(
        text(limits.loyaltyMemberId)
          .transform((s) => s.replace(MEMBER_ID_SEPARATORS, ''))
          .refine((s) => memberIdPattern.test(s), { error: MESSAGES.memberId }),
      ),
      memberType: field(
        text(limits.memberType).refine((s) => memberTypeCodes.has(s), {
          error: MESSAGES.memberType,
        }),
      ),
      country: field(
        text(limits.country, MESSAGES.country)
          .refine((s) => ASCII_ALPHA2.test(s), { error: MESSAGES.country, abort: true })
          .transform((s) => s.toUpperCase())
          .refine((s) => countries.isValid(s), { error: MESSAGES.country }),
      ),
      stateOrRegion: plain('stateOrRegion'),
      addressLine1: plain('addressLine1'),
      // Disabled in the UI until the XSD element is confirmed, but still one of the 12 fields.
      addressLine2: plain('addressLine2'),
      city: plain('city'),
      postalCode: plain('postalCode'),
    })
    .refine((q) => CRITERIA_FIELDS.some((f) => q[f] !== undefined), {
      error: NO_CRITERIA_MESSAGE,
      path: [],
      // Run only on an otherwise clean parse. Zod would skip this refine after
      // field errors anyway, but unrecognized_keys is continuable, so be explicit.
      when: (payload) => payload.issues.length === 0,
    });

  // Compile-time check that the inferred output matches GuestSearchQuery. Preprocess
  // makes Zod infer `unknown` inputs, so the declared input type is applied by cast.
  const typed: z.ZodType<GuestSearchQuery> = schema;
  return typed as z.ZodType<GuestSearchQuery, GuestSearchInput>;
}

/** True when the only problem is that no criterion was supplied (BFF → NO_CRITERIA). */
export function isNoCriteriaError(error: z.ZodError): boolean {
  const [only, ...rest] = error.issues;
  return rest.length === 0 && only?.path.length === 0 && only.message === NO_CRITERIA_MESSAGE;
}
