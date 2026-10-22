/**
 * SOAP request mapping for `searchGuestRequest` (Req 9, design.md "requestMapper.ts").
 *
 * Pure: a function of the normalized criteria, the header context and options, with no I/O
 * (Req 9.14). XML is built only through xmlbuilder2 `ele(nsUri, qname)`, `.att()` and
 * `.txt()`, which escape every value (Req 9.1, 9.2). Element identities, order and fixed
 * values come from `contract.ts` (Req 9.12, 9.13).
 *
 * Address Line 2 is never read (Req 9.6). `line1`, `locality1` and `postalCode` are emitted
 * only when their feature flag is on (Req 9.4); the route rejects disabled fields first
 * (Req 9.5), and the mapper ignores them defensively.
 */
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { DEFAULTS, EL, NS, ORDER, PREFIX, nsUri, qname, type El, type NsKey } from './contract.js';
import { appendHeader, type HeaderContext } from './headerBuilder.js';
import { xmlValue } from './xmlText.js';

export interface MapperOptions {
  maxResults: number;
  features: AppConfig['soap']['features'];
}

/** Namespace for `xmlns` declarations (fixed by the Namespaces in XML spec, not the contract). */
const XMLNS = 'http://www.w3.org/2000/xmlns/';

/**
 * True when `s` contains a character XML 1.0 forbids: U+0000-U+0008, U+000B, U+000C,
 * U+000E-U+001F, U+FFFE, U+FFFF, or a lone surrogate.
 */
export function hasXmlIllegalChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
    if (c === 0xfffe || c === 0xffff) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1); // NaN past the end
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // valid pair: skip the low surrogate
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Defensive assertion (the shared schema already rejects Cc/Cf), then the xmlbuilder2
 * ampersand work-around (see `xmlText.ts`). The message names neither the field value nor
 * the character, so it is safe to log.
 */
function checked(value: string): string {
  if (hasXmlIllegalChar(value)) {
    throw new AppError('INTERNAL_ERROR', 'Search criterion contains an XML 1.0 illegal character');
  }
  return xmlValue(value);
}

/** A supplied value, or `undefined` when absent or empty. */
const present = (v: string | undefined): string | undefined =>
  v === undefined || v === '' ? undefined : v;

const add = (parent: XMLBuilder, e: El): XMLBuilder => parent.ele(nsUri(e), qname(e));
const addText = (parent: XMLBuilder, e: El, value: string): void => {
  add(parent, e).txt(checked(value));
};

type GroupKey = (typeof ORDER.searchCriteria)[number];
type GroupBuilder = (criteria: XMLBuilder, q: GuestSearchQuery, o: MapperOptions) => void;

const GROUPS: Record<GroupKey, GroupBuilder> = {
  name(criteria, q) {
    const given = present(q.firstName);
    const surname = present(q.lastName);
    if (given === undefined && surname === undefined) return; // Req 9.7
    const name = add(criteria, EL.name);
    if (given !== undefined) addText(name, EL.given, given);
    if (surname !== undefined) addText(name, EL.surname, surname);
  },

  phone(criteria, q) {
    const number = present(q.phone);
    if (number === undefined) return; // Req 9.8
    add(criteria, EL.phone)
      .att('number', checked(number))
      .att('location', DEFAULTS.phoneLocation)
      .att('profileDefault', DEFAULTS.phoneProfileDefault);
  },

  email(criteria, q) {
    const address = present(q.email);
    if (address === undefined) return; // Req 9.9
    const email = add(criteria, EL.email).att('profileDefault', DEFAULTS.emailProfileDefault);
    addText(email, EL.emailAddress, address);
  },

  address(criteria, q, o) {
    // Placeholder source order until the XSD confirms it. Flagged fields drop out when
    // their flag is off, so a disabled field alone never creates the address element.
    // q.addressLine2 is deliberately never read (Req 9.6).
    const children: readonly [El, string | undefined][] = [
      [EL.line1, o.features.addressLine1 ? present(q.addressLine1) : undefined],
      [EL.locality1, o.features.city ? present(q.city) : undefined],
      [EL.region1, present(q.stateOrRegion)],
      [EL.postalCode, o.features.postalCode ? present(q.postalCode) : undefined],
      [EL.country, present(q.country)],
    ];
    const emitted = children.filter((c): c is [El, string] => c[1] !== undefined);
    if (emitted.length === 0) return; // Req 9.10
    const source = add(
      add(criteria, EL.address)
        .att('locationCode', DEFAULTS.addressLocationCode)
        .att('profileDefault', DEFAULTS.addressProfileDefault),
      EL.source,
    );
    for (const [e, value] of emitted) addText(source, e, value);
  },

  membership(criteria, q) {
    const code = present(q.memberType);
    const value = present(q.loyaltyMemberId);
    if (code === undefined && value === undefined) return; // Req 9.11
    const membership = add(criteria, EL.membership);
    if (code !== undefined) membership.att('code', checked(code));
    if (value !== undefined) membership.att('value', checked(value));
  },
};

type RequestChildKey = (typeof ORDER.searchGuestRequest)[number];

/** Build the full SOAP 1.1 envelope for `searchGuestRequest` and serialize it. */
export function buildSearchGuestRequest(
  q: GuestSearchQuery,
  h: HeaderContext,
  o: MapperOptions,
): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const envelope = add(doc, EL.envelope);
  // Declare every namespace once on the envelope with the sample's aliases (Req 7.1).
  for (const key of Object.keys(NS) as NsKey[]) {
    if (key === 'soap') continue; // declared by the element's own qualified name
    const prefix = PREFIX[key];
    envelope.att(XMLNS, prefix === '' ? 'xmlns' : 'xmlns:' + prefix, NS[key]);
  }

  appendHeader(add(envelope, EL.soapHeader), h);
  const request = add(add(envelope, EL.body), EL.searchGuestRequest);

  const childBuilders: Record<RequestChildKey, (parent: XMLBuilder) => void> = {
    searchCriteria(parent) {
      const criteria = add(parent, EL.searchCriteria).att('status', DEFAULTS.criteriaStatus);
      for (const key of ORDER.searchCriteria) GROUPS[key](criteria, q, o);
    },
    allAttributes(parent) {
      add(parent, EL.allAttributes).txt(DEFAULTS.allAttributes);
    },
    allHistory(parent) {
      add(parent, EL.allHistory).txt(DEFAULTS.allHistory);
    },
    maxResults(parent) {
      add(parent, EL.maxResults).txt(String(o.maxResults));
    },
  };
  for (const key of ORDER.searchGuestRequest) childBuilders[key](request);

  return doc.end({ prettyPrint: false });
}
