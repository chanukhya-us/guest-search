/**
 * SOAP header construction (Req 8, design.md "headerBuilder.ts").
 *
 * The backend owns every header value: users never supply or see them (Req 3.7, 6.7). The
 * transaction ID is the request ID (Req 8.1), the timestamp is taken from an injected clock at
 * send time (Req 8.2, 8.7) and everything else comes from runtime configuration (Req 8.3, 8.6).
 *
 * Element names come from `EL` and are provisional (Blocker B2). The service credential is
 * never emitted while `HEADER_CREDENTIAL_LOCATION` is `null` (Blockers B5/B6): it is not even
 * copied into `HeaderContext`.
 */
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import type { AppConfig } from '../config.js';
import { EL, ORDER, nsUri, qname } from './contract.js';
import { xmlValue } from './xmlText.js';

export interface HeaderContext {
  transactionId: string;
  sequence: number;
  /** ISO 8601 UTC `xs:dateTime`, e.g. `2026-10-21T12:00:00.000Z`. */
  timestamp: string;
  languageCode: string;
  countryCode: string;
  channel: string;
  subChannel: string;
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
    subChannel: cfg.subChannel,
    environment: cfg.environment,
    serviceUser: cfg.serviceUser,
  };
}

/** Header child key in `ORDER.header` → the `HeaderContext` value it carries. */
const VALUE: Record<(typeof ORDER.header)[number], (h: HeaderContext) => string> = {
  headerTransactionId: (h) => h.transactionId,
  headerSequence: (h) => String(h.sequence),
  headerTimestamp: (h) => h.timestamp,
  headerLanguageCode: (h) => h.languageCode,
  headerCountryCode: (h) => h.countryCode,
  headerChannel: (h) => h.channel,
  headerSubChannel: (h) => h.subChannel,
  headerEnvironment: (h) => h.environment,
  headerServiceUser: (h) => h.serviceUser,
};

/**
 * Append the namespace-aware header element (and its children, in `ORDER.header`) to
 * `parent`. Text goes through xmlbuilder2 `.txt()`, which escapes it.
 */
export function appendHeader(parent: XMLBuilder, h: HeaderContext): void {
  const header = parent.ele(nsUri(EL.header), qname(EL.header));
  for (const key of ORDER.header) {
    const e = EL[key];
    header.ele(nsUri(e), qname(e)).txt(xmlValue(VALUE[key](h)));
  }
}
