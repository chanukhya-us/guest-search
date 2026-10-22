/**
 * SOAP header construction (Req 8, design.md "headerBuilder.ts").
 *
 * The backend owns every header value: users never supply or see them (Req 3.7, 6.7). The
 * transaction ID is the request ID (Req 8.1), the timestamp is taken from an injected clock at
 * send time (Req 8.2, 8.7), the header version comes from `DEFAULTS` and everything else comes
 * from runtime configuration (Req 8.3, 8.6).
 *
 * Shape, from the team's sample request (docs/Request.txt): `header` is the first child of
 * `searchGuestRequest` (there is no soap:Header), every element is in `common`, and every value
 * is an attribute except `sendTimeStamp`:
 *
 *   <header>
 *     <language isoCountryCode="US" isoLanguageCode="en"/>
 *     <channel name="…"><subChannel name="…"><subChannel name="…"/></subChannel></channel>
 *     <headerVersion major="1" minor="0"/>
 *     <environment name="…"/>
 *     <user id="<service user>"/>
 *     <transactionId id="<requestId>"/>
 *     <transactionSequence number="1"/>
 *     <sendTimeStamp>2026-10-21T12:00:00.000Z</sendTimeStamp>
 *   </header>
 *
 * The service credential is never emitted while `HEADER_CREDENTIAL_LOCATION` is `null`
 * (Blockers B5/B6): it is not even copied into `HeaderContext`.
 */
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import type { AppConfig } from '../config.js';
import { DEFAULTS, EL, ORDER, nsUri, qname, type El } from './contract.js';
import { xmlValue } from './xmlText.js';

export interface HeaderContext {
  transactionId: string;
  sequence: number;
  /** ISO 8601 UTC `xs:dateTime`, e.g. `2026-10-21T12:00:00.000Z`. */
  timestamp: string;
  languageCode: string;
  countryCode: string;
  channel: string;
  /** Outermost first; each subchannel nests inside the previous one. May be empty. */
  subChannels: readonly string[];
  environment: string;
  serviceUser: string;
}

export interface HeaderDeps {
  now: () => Date;
  requestId: string;
}

/** Build the per-request header values. Pure apart from the injected clock. */
export function createHeaderContext(
  cfg: AppConfig['soap']['header'],
  deps: HeaderDeps,
): HeaderContext {
  return {
    transactionId: deps.requestId,
    sequence: cfg.sequence,
    timestamp: deps.now().toISOString(),
    languageCode: cfg.languageCode,
    countryCode: cfg.countryCode,
    channel: cfg.channel,
    subChannels: [...cfg.subChannels],
    environment: cfg.environment,
    serviceUser: cfg.serviceUser,
  };
}

const add = (parent: XMLBuilder, e: El): XMLBuilder => parent.ele(nsUri(e), qname(e));

/** Header child key in `ORDER.header` → how to write it. Values are escaped by xmlbuilder2. */
const WRITE: Record<(typeof ORDER.header)[number], (header: XMLBuilder, h: HeaderContext) => void> =
  {
    headerLanguage(header, h) {
      add(header, EL.headerLanguage)
        .att('isoCountryCode', xmlValue(h.countryCode))
        .att('isoLanguageCode', xmlValue(h.languageCode));
    },
    headerChannel(header, h) {
      let level = add(header, EL.headerChannel).att('name', xmlValue(h.channel));
      for (const sub of h.subChannels) {
        level = add(level, EL.headerSubChannel).att('name', xmlValue(sub));
      }
    },
    headerVersion(header) {
      add(header, EL.headerVersion)
        .att('major', DEFAULTS.headerVersionMajor)
        .att('minor', DEFAULTS.headerVersionMinor);
    },
    headerEnvironment(header, h) {
      add(header, EL.headerEnvironment).att('name', xmlValue(h.environment));
    },
    headerUser(header, h) {
      add(header, EL.headerUser).att('id', xmlValue(h.serviceUser));
    },
    headerTransactionId(header, h) {
      add(header, EL.headerTransactionId).att('id', xmlValue(h.transactionId));
    },
    headerTransactionSequence(header, h) {
      add(header, EL.headerTransactionSequence).att('number', String(h.sequence));
    },
    headerSendTimeStamp(header, h) {
      add(header, EL.headerSendTimeStamp).txt(xmlValue(h.timestamp));
    },
  };

/** Append the namespace-aware `header` element, children in `ORDER.header`, to `parent`. */
export function appendHeader(parent: XMLBuilder, h: HeaderContext): void {
  const header = add(parent, EL.header);
  for (const key of ORDER.header) WRITE[key](header, h);
}
