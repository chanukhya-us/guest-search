/**
 * Guest search port (Req 6.8; design.md "apps/bff — service layer").
 *
 * The service layer and routes depend on this interface only. The SOAP adapter
 * (`soap/soapGuestSearchGateway.ts`) implements it, so another adapter (REST, cloud) can
 * replace SOAP without touching callers. Layer rule: this module imports only from
 * `@ihg-guest-search/shared`; it never imports from `soap/` (enforced by `layering.test.ts`).
 */
import type { GuestSearchQuery, GuestSearchResult } from '@ihg-guest-search/shared';

export interface GuestSearchContext {
  /** Correlation id; the adapter uses it as the upstream transaction id (Req 8.1). */
  requestId: string;
}

export interface GuestSearchOutcome {
  results: GuestSearchResult[];
  /** The `maxResults` cap sent upstream, so callers can tell "capped" from "complete". */
  limit: number;
}

export interface GuestSearchGateway {
  /**
   * Run one search. Rejects with a typed error (`code` is a catalog `ErrorCode`, e.g. an
   * `UPSTREAM_*` code) whose message carries no payload or PII.
   */
  search(query: GuestSearchQuery, ctx: GuestSearchContext): Promise<GuestSearchOutcome>;
}
