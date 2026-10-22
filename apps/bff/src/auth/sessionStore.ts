/**
 * Server-side session store (design.md "Server-side state", Req 20.10).
 *
 * The browser holds only an opaque, signed session ID cookie; every session attribute
 * lives here, keyed by that ID. This keeps the Principal server-side (the identity layer's
 * preferred model for a first-party web app) and lets the whole session be revoked by
 * deleting one entry.
 *
 * Two timeouts are enforced on every read:
 *   - idle: `ttlMs` since `lastSeen`, slid forward on each successful `get` (activity).
 *   - absolute: `absoluteMs` since `createdAt`, a hard cap that activity cannot extend.
 * An expired session is removed and treated as absent.
 *
 * The clock (`now`) and the ID generator (`idGenerator`) are injected so tests are
 * deterministic. The default generator draws 256 bits from `node:crypto` (Req: session
 * IDs need >= 128 bits of entropy) and base64url-encodes it so it is cookie-safe.
 *
 * `MemorySessionStore` is a single-process Map: sessions are lost on restart and are not
 * shared across instances. This is acceptable for the local MVP and is documented as a
 * production limitation (ADR 0003); a Redis-backed `SessionStore` replaces it later without
 * touching callers.
 */
import { randomBytes } from 'node:crypto';

/** One stored session. `principalId` links to the authenticated caller (design.md). */
export interface SessionRecord {
  readonly id: string;
  /** Epoch ms when the session was created; the absolute timeout is measured from here. */
  readonly createdAt: number;
  /** Epoch ms of the last activity; the idle timeout is measured from here and slides. */
  readonly lastSeen: number;
  /** Identifier of the bound Principal (`Principal.id`). */
  readonly principalId: string;
}

/**
 * Session persistence boundary. A Redis-backed implementation can replace
 * `MemorySessionStore` without changing the plugin or services (design.md "Sessions").
 */
export interface SessionStore {
  /** Create a session for `principalId`, returning the new record (with its fresh ID). */
  create(principalId: string): SessionRecord;
  /**
   * Fetch a live session by ID, enforcing both timeouts and sliding the idle clock.
   * Returns `null` when the ID is unknown or the session has expired (expired entries
   * are removed as a side effect).
   */
  get(id: string): SessionRecord | null;
  /**
   * Replace the Principal bound to an existing, live session, keeping its ID and
   * `createdAt`. Returns the updated record, or `null` if the session is unknown/expired.
   * Supports a future dev persona switch without rotating the cookie.
   */
  updatePrincipal(id: string, principalId: string): SessionRecord | null;
  /** Remove a session (logout / revocation). Safe to call for an unknown ID. */
  destroy(id: string): void;
}

/** Injected dependencies; defaults are production-safe, overridden in tests. */
export interface MemorySessionStoreOptions {
  /** Idle timeout in milliseconds (slides on activity). */
  ttlMs: number;
  /** Absolute lifetime cap in milliseconds (from `createdAt`). */
  absoluteMs: number;
  /** Clock, injected for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Opaque ID generator. Defaults to 256 bits of CSPRNG entropy, base64url-encoded. */
  idGenerator?: () => string;
}

/** 32 random bytes = 256 bits of entropy, URL-safe for cookie values. */
export function defaultIdGenerator(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * In-memory `SessionStore`. Single-process only (see module doc). Expired entries are
 * swept lazily on `get`; a periodic sweep is unnecessary at local-MVP scale.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ttlMs: number;
  private readonly absoluteMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(options: MemorySessionStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.absoluteMs = options.absoluteMs;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
  }

  create(principalId: string): SessionRecord {
    const nowMs = this.now();
    const record: SessionRecord = {
      id: this.idGenerator(),
      createdAt: nowMs,
      lastSeen: nowMs,
      principalId,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(id: string): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;

    const nowMs = this.now();
    if (this.isExpired(record, nowMs)) {
      this.sessions.delete(id);
      return null;
    }

    // Slide the idle clock forward on activity; the absolute cap is untouched.
    const slid: SessionRecord = { ...record, lastSeen: nowMs };
    this.sessions.set(id, slid);
    return slid;
  }

  updatePrincipal(id: string, principalId: string): SessionRecord | null {
    const live = this.get(id);
    if (live === null) return null;
    const updated: SessionRecord = { ...live, principalId };
    this.sessions.set(id, updated);
    return updated;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  /** A session is dead once it passes either the idle or the absolute deadline. */
  private isExpired(record: SessionRecord, nowMs: number): boolean {
    return nowMs - record.lastSeen >= this.ttlMs || nowMs - record.createdAt >= this.absoluteMs;
  }
}
