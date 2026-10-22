/**
 * Reveal-token store (design.md "RevealStore", Req 14.6, 14.9).
 *
 * When a colleague with the `GuestSearch.RevealPII` role runs a search, the BFF keeps the
 * *unmasked* phones and emails for each matched guest server-side and hands the browser only
 * an opaque `rt_…` token. Exchanging that token at `POST /api/v1/guests/reveal` returns the
 * real values for that one guest. The raw PII therefore never rides along in the search
 * response; it lives here, bounded and session-scoped, until it expires.
 *
 * Security properties enforced here (threat-model driven):
 *   - Opaque, unguessable tokens: `rt_` + base64url(24 CSPRNG bytes) = 192 bits of entropy.
 *     The token carries no PII and no structure a caller could forge or enumerate.
 *   - Session binding (Req 14.9): `consume` returns null unless the caller's `sessionId`
 *     matches the issuing session. A token leaked to, or guessed by, another session is
 *     useless — this blocks horizontal token reuse (IDOR via a stolen token).
 *   - Single-guest scope: one entry holds exactly one guest's phones and emails, so a reveal
 *     can never widen to another guest's data.
 *   - TTL expiry (Req 14.6, default 10 min): an entry past `expiresAt` is treated as absent
 *     and swept. The route maps a null `consume` to `REVEAL_EXPIRED` (Req 14.9), so unknown,
 *     expired and cross-session tokens are indistinguishable to the caller (no oracle).
 *   - Logout teardown (Req 20.11): `dropSession` removes every entry for a session so signing
 *     out discards all reveal material immediately.
 *
 * Re-reveal is allowed until the TTL lapses: `consume` does NOT delete on success, so a
 * colleague can re-open a row within the window without a fresh search (design.md note). This
 * is a deliberate usability choice bounded by the short TTL, not a one-time token.
 *
 * `enterpriseIdHash` is computed by the caller (see `hashEnterpriseId`) and stored only for
 * the audit log (Req 14.10); the store itself never logs and holds no plaintext identifier
 * beyond the contact collections it must keep.
 *
 * The clock (`now`) and token generator (`idGenerator`) are injected for deterministic tests,
 * mirroring `MemorySessionStore`. `MemoryRevealStore` is a single-process Map: entries are
 * lost on restart and not shared across instances — acceptable for the local MVP and recorded
 * as a production limitation (a Redis/KV-backed store replaces it without touching callers).
 */
import { createHmac, randomBytes } from 'node:crypto';

import type { GuestEmail, GuestPhone } from '@ihg-guest-search/shared';

/** One stored reveal: the unmasked contacts for a single guest, scoped to one session. */
export interface RevealEntry {
  /** Issuing session ID; `consume` requires an exact match (Req 14.9). */
  readonly sessionId: string;
  /** Request ID of the search that issued the token (audit correlation, Req 14.10). */
  readonly requestId: string;
  /** HMAC of the Enterprise ID, for the reveal audit event only (Req 14.10). Never plaintext. */
  readonly enterpriseIdHash: string;
  /** The unmasked phones for this guest. */
  readonly phones: readonly GuestPhone[];
  /** The unmasked emails for this guest. */
  readonly emails: readonly GuestEmail[];
  /** Epoch ms after which the entry is expired and treated as absent (Req 14.6). */
  readonly expiresAt: number;
}

/**
 * Reveal persistence boundary. A distributed implementation can replace `MemoryRevealStore`
 * without changing the service or routes (design.md "Server-side state").
 */
export interface RevealStore {
  /**
   * Store the unmasked contacts for one guest and return a fresh opaque token. `expiresAt`
   * is computed from the injected clock plus the configured TTL.
   */
  issue(entry: Omit<RevealEntry, 'expiresAt'>): string;
  /**
   * Exchange a token for its entry. Returns `null` when the token is unknown, expired, or
   * bound to a different session (all three are indistinguishable to the caller). The entry
   * is NOT deleted on success: re-reveal is permitted until the TTL lapses.
   */
  consume(token: string, sessionId: string): RevealEntry | null;
  /** Remove every entry issued to `sessionId` (logout / revocation, Req 20.11). */
  dropSession(sessionId: string): void;
}

/** Injected dependencies; defaults are production-safe and overridden in tests. */
export interface MemoryRevealStoreOptions {
  /** Token lifetime in milliseconds (Req 14.6; 10 min by default via config). */
  ttlMs: number;
  /** Clock, injected for deterministic TTL tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Opaque token generator. Defaults to `rt_` + base64url(24 CSPRNG bytes). */
  idGenerator?: () => string;
}

/** `rt_` + 24 random bytes (192 bits) base64url-encoded: opaque, URL-safe, non-guessable. */
export function defaultTokenGenerator(): string {
  return `rt_${randomBytes(24).toString('base64url')}`;
}

/**
 * HMAC-SHA256(sessionSecret, enterpriseId) truncated to 16 hex characters (design.md). Used
 * only to correlate reveal audit events to a guest without storing or logging the plaintext
 * Enterprise ID (Req 14.10). Keyed with the session secret so the hash is not a stable,
 * cross-deployment identifier for an individual.
 */
export function hashEnterpriseId(sessionSecret: string, enterpriseId: string): string {
  return createHmac('sha256', sessionSecret)
    .update(enterpriseId, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * In-memory `RevealStore`. Single-process only (see module doc). Expired entries are swept
 * lazily on `consume` and, cheaply, whenever a session is dropped.
 */
export class MemoryRevealStore implements RevealStore {
  private readonly entries = new Map<string, RevealEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(options: MemoryRevealStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? defaultTokenGenerator;
  }

  issue(entry: Omit<RevealEntry, 'expiresAt'>): string {
    const token = this.idGenerator();
    const stored: RevealEntry = { ...entry, expiresAt: this.now() + this.ttlMs };
    this.entries.set(token, stored);
    return token;
  }

  consume(token: string, sessionId: string): RevealEntry | null {
    const entry = this.entries.get(token);
    if (entry === undefined) return null;

    // Expired: remove and treat as absent.
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(token);
      return null;
    }

    // Session binding: a token is usable only by the session it was issued to (Req 14.9).
    // The wrong-session case is reported identically to unknown/expired — no oracle.
    if (entry.sessionId !== sessionId) return null;

    // Success: the entry is retained so the same row can be revealed again within the TTL.
    return entry;
  }

  dropSession(sessionId: string): void {
    for (const [token, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(token);
      }
    }
  }
}
