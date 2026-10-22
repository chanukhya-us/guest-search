/**
 * GuestSearchService (task 8.4; design.md "apps/bff — service layer"; Req 6.4, 6.5, 13.4,
 * 14.5, 14.7, 14.10).
 *
 * This is the one place where a validated query becomes a masked, reveal-enabled
 * `GuestSearchResponse`, and where a reveal token is exchanged for one guest's unmasked
 * contacts. It sits between the routes (task 8.6) and the `GuestSearchGateway` port, so it
 * holds no Fastify and no SOAP knowledge — only the gateway port, the shared schema, the
 * PII masker, the reveal store, and injected observability hooks.
 *
 * ## Validation ownership
 * `search()` takes the *raw* client input and validates it with the shared criteria schema
 * (`createCriteriaSchema`), so the authoritative "is this a valid search" decision lives in
 * one typed place regardless of which caller (route, test, future transport) invokes it. A
 * NO_CRITERIA-only Zod error becomes `AppError('NO_CRITERIA')`; every other validation
 * problem becomes `AppError('VALIDATION_ERROR')` carrying the per-field messages for the HTTP
 * error handler (task 8.5). The route (task 8.6) still owns the concerns the schema cannot
 * see — role gating, the server-side `libphonenumber-js/max` phone check, and the
 * disabled-feature-field rejection (Req 9.5) — before delegating here.
 *
 * ## search() ordering (design.md, followed exactly)
 *   1. Validate the input → `GuestSearchQuery` (or throw NO_CRITERIA / VALIDATION_ERROR).
 *   2. Call the gateway with the validated query and the request id.
 *   3. For each result, compute primaries with `pickPrimary` on the REAL, unmasked data.
 *   4. If (and only if) the principal holds `GuestSearch.RevealPII`, store the unmasked
 *      phones and emails in the `RevealStore` (session-bound, with an HMAC Enterprise-ID hash
 *      for audit) and attach the returned opaque token to the summary.
 *   5. Mask phones and emails (`PiiMasker`) so the response carries only masked contacts
 *      (Req 14.1-14.3). Masking runs AFTER primary selection and token issuance, so neither
 *      the primary choice nor the stored reveal material is ever computed from masked data.
 *   6. Record observability (metrics, log line with criteria field NAMES only, audit).
 *   7. Return `{ requestId, success: true, totalResults, limit, results }` with
 *      `totalResults = results.length` (Req 6.4, 6.5).
 *
 * ## Reveal-token issuance is role-gated here (defense in depth)
 * A token is issued only when the caller could actually use it (Req 14.5: the Reveal_Token is
 * present only WHERE the principal holds `GuestSearch.RevealPII`). A Read-only colleague never
 * receives tokens, so there is nothing to leak and nothing to enumerate. The reveal ROUTE
 * (task 8.6) independently enforces the same role before `reveal()` runs, and the store binds
 * every token to the issuing session — three layers, no single point of failure.
 *
 * ## PII / logging discipline (Req 22.3, 22.4; appsec review)
 * Nothing in this module ever logs a criteria VALUE, a contact value, an Enterprise ID, a
 * token, or any masked/unmasked field. The completion log line carries only the NAMES of the
 * criteria fields that were supplied, the result count and the outcome. Thrown `AppError`s
 * carry an operator-facing message with no PII; the per-field validation messages come from
 * the shared schema and describe the rule, never echo the submitted value.
 *
 * ## Deferred: audit logging (task 9.1)
 * The audit sink is injected as an optional `AuditLogger` with a no-op default, mirroring the
 * logger/metrics pattern already established in `soapGuestSearchGateway.ts`. When task 9.1
 * wires the separate pino audit instance, it passes a real implementation; the call sites for
 * `guest.search` and `guest.reveal` events already live here (steps 6 and the reveal path),
 * so 9.1 only supplies the destination. The Enterprise-ID hash each event needs is computed
 * here via `hashEnterpriseId` and never leaves as plaintext (Req 14.10).
 */
import {
  ERROR_CATALOG,
  ROLES,
  isNoCriteriaError,
  pickPrimary,
  type CriteriaField,
  type GuestEmail,
  type GuestPhone,
  type GuestSearchInput,
  type GuestSearchQuery,
  type GuestSearchResponse,
  type GuestSearchResult,
  type GuestSummary,
  type RevealResponse,
} from '@ihg-guest-search/shared';
import type { z } from 'zod';

import type { Principal } from '../auth/authProvider.js';
import { hasRole } from '../auth/requireRole.js';
import { AppError } from '../errors.js';
import type { GuestSearchGateway } from '../ports/GuestSearchGateway.js';
import { maskEmail, maskPhone } from '../security/piiMasker.js';
import { hashEnterpriseId, type RevealStore } from '../security/revealStore.js';

/** The per-request identity and session the service operates under (design.md SearchContext). */
export interface SearchContext {
  /** Correlation id; also the upstream transaction id. Present in every response (Req 6.6). */
  readonly requestId: string;
  /** The authenticated caller; drives reveal-token issuance (Req 14.5). */
  readonly principal: Principal;
  /** The session the tokens are bound to (Req 14.9) and that logout drops (Req 20.11). */
  readonly sessionId: string;
}

/**
 * The compiled shared criteria schema. Built once by the caller from `createCriteriaSchema`
 * (with `defaultSchemaConfig` or the configured member types / limits) and injected, so the
 * service stays independent of how the config is assembled and tests can supply a schema
 * directly.
 */
export type CriteriaSchema = z.ZodType<GuestSearchQuery, GuestSearchInput>;

/** Structural subset of pino's `Logger` (task 9 passes the real logger; default is no-op). */
export interface ServiceLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Audit sink (Req 14.10, 22.5). A separate stream from the application logger. Task 9.1 wires
 * the real pino audit instance; until then the default is a no-op. Payloads NEVER contain
 * contact values or plaintext identifiers — only the principal id, request id, an
 * Enterprise-ID HMAC and a timestamp.
 */
export interface AuditEvent {
  readonly event: 'guest.search' | 'guest.reveal';
  readonly principalId: string;
  readonly requestId: string;
  /** Epoch ms, from the injected clock. */
  readonly at: number;
  /** HMAC of the Enterprise ID (reveal only); absent for search. Never plaintext (Req 14.10). */
  readonly enterpriseIdHash?: string;
  /** Result count for a search event; absent for reveal. */
  readonly resultCount?: number;
}

export interface AuditLogger {
  record(event: AuditEvent): void;
}

/** Instruments the service feeds (task 9 maps these onto `gs.*` meters). Default: no-op. */
export interface ServiceMetrics {
  /** One completed search: outcome bucket and result count (no criteria, no PII). */
  searchCompleted(attrs: { outcome: 'success' | 'empty'; resultCount: number }): void;
  /** One reveal attempt; `ok` is false for an expired/unknown/cross-session token. */
  revealAttempted(attrs: { ok: boolean }): void;
}

export interface GuestSearchServiceDeps {
  /** The port the service searches through (Req 6.8). The SOAP adapter implements it. */
  readonly gateway: GuestSearchGateway;
  /** Compiled shared criteria schema (see `CriteriaSchema`). */
  readonly schema: CriteriaSchema;
  /** Reveal-token persistence (session-bound, TTL'd). */
  readonly revealStore: RevealStore;
  /** HMAC key for the audit Enterprise-ID hash (Req 14.10). The session secret from config. */
  readonly sessionSecret: string;
  /** Clock, injected for deterministic audit timestamps. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Application logger (no-op until task 9.1). */
  readonly logger?: ServiceLogger;
  /** Audit sink (no-op until task 9.1). */
  readonly audit?: AuditLogger;
  /** Metrics hooks (no-op until task 9.2). */
  readonly metrics?: ServiceMetrics;
}

const NOOP_LOGGER: ServiceLogger = { info: () => undefined };
const NOOP_AUDIT: AuditLogger = { record: () => undefined };
const NOOP_METRICS: ServiceMetrics = {
  searchCompleted: () => undefined,
  revealAttempted: () => undefined,
};

export class GuestSearchService {
  private readonly gateway: GuestSearchGateway;
  private readonly schema: CriteriaSchema;
  private readonly revealStore: RevealStore;
  private readonly sessionSecret: string;
  private readonly now: () => number;
  private readonly logger: ServiceLogger;
  private readonly audit: AuditLogger;
  private readonly metrics: ServiceMetrics;

  constructor(deps: GuestSearchServiceDeps) {
    this.gateway = deps.gateway;
    this.schema = deps.schema;
    this.revealStore = deps.revealStore;
    this.sessionSecret = deps.sessionSecret;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.audit = deps.audit ?? NOOP_AUDIT;
    this.metrics = deps.metrics ?? NOOP_METRICS;
  }

  /**
   * Validate the input, run the search, and return a masked, reveal-enabled response.
   *
   * @throws AppError('NO_CRITERIA') when the only validation problem is that no criterion was
   *   supplied; AppError('VALIDATION_ERROR') (with per-field messages) for any other
   *   validation problem. Gateway errors (`UPSTREAM_*`, `INTERNAL_ERROR`) propagate unchanged.
   */
  async search(input: GuestSearchInput, ctx: SearchContext): Promise<GuestSearchResponse> {
    // Step 1 — validate (authoritative). NO_CRITERIA vs VALIDATION_ERROR per the schema's
    // single-root-issue contract (shared `isNoCriteriaError`).
    const query = this.validate(input);

    // Step 2 — gateway. The validated query (never the raw input) crosses the port boundary.
    const { results, limit } = await this.gateway.search(query, { requestId: ctx.requestId });

    // Step 3-5 — per result: primaries on real data, then token (role-gated), then mask.
    const canReveal = hasRole(ctx.principal, ROLES.REVEAL);
    const summaries = results.map((result) => this.toSummary(result, ctx, canReveal));

    // Step 6 — observability. Field NAMES only; no values ever leave this module (Req 22.3).
    const criteriaFields = suppliedFieldNames(query);
    const outcome = summaries.length === 0 ? 'empty' : 'success';
    this.metrics.searchCompleted({ outcome, resultCount: summaries.length });
    this.audit.record({
      event: 'guest.search',
      principalId: ctx.principal.id,
      requestId: ctx.requestId,
      at: this.now(),
      resultCount: summaries.length,
    });
    this.logger.info(
      {
        event: 'guest.search.completed',
        requestId: ctx.requestId,
        criteriaFields,
        resultCount: summaries.length,
        outcome,
      },
      'guest search completed',
    );

    // Step 7 — response. totalResults = results.length (Req 6.4, 6.5).
    return {
      requestId: ctx.requestId,
      success: true,
      totalResults: summaries.length,
      limit,
      results: summaries,
    };
  }

  /**
   * Exchange a reveal token for one guest's unmasked phones and emails.
   *
   * The store enforces session binding and TTL: a token that is unknown, expired, or bound to
   * another session comes back `null` and is reported identically as `REVEAL_EXPIRED` (Req
   * 14.9) — no oracle. On success an audit event is written (Req 14.10) with the HMAC
   * Enterprise-ID hash stored at issue time, never a plaintext identifier.
   *
   * @throws AppError('REVEAL_EXPIRED') for any unusable token.
   */
  async reveal(token: string, ctx: SearchContext): Promise<RevealResponse> {
    const entry = this.revealStore.consume(token, ctx.sessionId);
    if (entry === null) {
      this.metrics.revealAttempted({ ok: false });
      this.logger.info(
        { event: 'guest.reveal.rejected', requestId: ctx.requestId },
        'reveal token rejected',
      );
      throw new AppError('REVEAL_EXPIRED', ERROR_CATALOG.REVEAL_EXPIRED.message);
    }

    this.metrics.revealAttempted({ ok: true });
    this.audit.record({
      event: 'guest.reveal',
      principalId: ctx.principal.id,
      requestId: ctx.requestId,
      at: this.now(),
      enterpriseIdHash: entry.enterpriseIdHash,
    });
    this.logger.info(
      { event: 'guest.reveal.succeeded', requestId: ctx.requestId },
      'reveal succeeded',
    );

    // Return fresh arrays of plain objects so callers cannot mutate the stored entry, and so
    // the readonly collections become the mutable arrays the response type declares.
    return {
      requestId: ctx.requestId,
      phones: entry.phones.map((p) => ({ ...p })),
      emails: entry.emails.map((e) => ({ ...e })),
    };
  }

  /** Step 1: parse with the shared schema and map Zod failure to the right catalog code. */
  private validate(input: GuestSearchInput): GuestSearchQuery {
    const parsed = this.schema.safeParse(input);
    if (parsed.success) return parsed.data;

    const { error } = parsed;
    if (isNoCriteriaError(error)) {
      throw new AppError('NO_CRITERIA', 'No search criteria supplied');
    }
    throw new AppError('VALIDATION_ERROR', 'Criteria validation failed', {
      cause: toFieldErrors(error),
    });
  }

  /** Steps 3-5 for one result: primaries (real data) → token (role-gated) → mask. */
  private toSummary(
    result: GuestSearchResult,
    ctx: SearchContext,
    canReveal: boolean,
  ): GuestSummary {
    // Step 3 — primaries from the UNMASKED result (computed once per collection). The phone
    // and email primaries are masked for display, consistent with Req 14.1-14.3; the choice
    // itself was made on real data, so the correct item is selected before masking.
    const primaryAddress = pickPrimary(result.addresses);
    const primaryPhone = pickPrimary(result.phones);
    const primaryEmail = pickPrimary(result.emails);
    const primaryMembership = pickPrimary(result.memberships);
    const primary: GuestSummary['primary'] = {
      ...(primaryAddress !== undefined && { address: primaryAddress }),
      ...(primaryPhone !== undefined && { phone: maskPhoneValue(primaryPhone) }),
      ...(primaryEmail !== undefined && { email: maskEmailValue(primaryEmail) }),
      ...(primaryMembership !== undefined && { membership: primaryMembership }),
    };

    // Step 4 — reveal token, only for a principal that could use it (Req 14.5).
    let revealToken: string | undefined;
    if (canReveal && (result.phones.length > 0 || result.emails.length > 0)) {
      revealToken = this.revealStore.issue({
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        enterpriseIdHash: hashEnterpriseId(this.sessionSecret, result.enterpriseId),
        phones: result.phones.map((p) => ({ ...p })),
        emails: result.emails.map((e) => ({ ...e })),
      });
    }

    // Step 5 — mask the full phone/email collections in the response copy of the guest.
    const guest: GuestSearchResult = {
      ...result,
      phones: result.phones.map(maskPhoneValue),
      emails: result.emails.map(maskEmailValue),
    };

    return { guest, primary, ...(revealToken !== undefined && { revealToken }) };
  }
}

/** Mask a phone's display number, preserving every other (non-PII) attribute. */
function maskPhoneValue(phone: GuestPhone): GuestPhone {
  return { ...phone, number: maskPhone(phone.number) };
}

/** Mask an email's display address, preserving `profileDefault`. */
function maskEmailValue(email: GuestEmail): GuestEmail {
  return { ...email, address: maskEmail(email.address) };
}

/** The NAMES of the criteria fields that were supplied, in stable key order (no values). */
function suppliedFieldNames(query: GuestSearchQuery): CriteriaField[] {
  return (Object.keys(query) as CriteriaField[]).filter((k) => query[k] !== undefined);
}

/**
 * Flatten a Zod error into per-field messages for the HTTP error handler. A root issue
 * (`path.length === 0`) maps to the field label `'root'`; every other issue uses its first
 * path segment (a `CriteriaField`). Messages are the schema's rule text — they never contain
 * the submitted value (Req 19.3, appsec review). Duplicate (field, message) pairs are
 * de-duplicated; the first message per field wins to keep the summary stable.
 */
export interface FieldError {
  field: CriteriaField | 'root';
  message: string;
}

function toFieldErrors(error: z.ZodError): FieldError[] {
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const issue of error.issues) {
    const field = (issue.path.length === 0 ? 'root' : String(issue.path[0])) as
      CriteriaField | 'root';
    const key = `${field}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, message: issue.message });
  }
  return out;
}
