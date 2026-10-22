/**
 * Audit logger (task 9.1; design.md "apps/bff — observability" → audit.ts; Req 22.5, 14.10,
 * 19.4-adjacent).
 *
 * The audit log is a SEPARATE stream from the application log, with a different purpose and a
 * different retention story: it is the tamper-evident record of *who looked up whom*, written as
 * append-only JSON lines so a security reviewer can answer "which colleague searched, and which
 * guest's details did they reveal, and when" without ever finding a contact value in the file.
 *
 * ## Why a separate instance, not a child of the app logger
 * The app logger can be at `info`/`warn`/`debug`, can be pretty-printed in dev, and ships to
 * stdout; the audit log must be unconditional, machine-parseable NDJSON, and go to its own
 * durable destination (`config.log.auditLogPath`, default `logs/audit.jsonl`). Mixing the two
 * would let an app-log level change silence the audit trail, and would interleave audit lines
 * with request noise. So this is its own pino instance writing to its own destination.
 *
 * ## The event schema (the only shape ever written) — Req 14.10, 22.5
 *   {
 *     "event": "audit",              // top-level discriminator so audit lines are greppable
 *     "action": "guest.search" | "guest.reveal",
 *     "who": "<principal id>",       // the colleague, NOT the guest
 *     "when": "<ISO 8601 UTC>",      // from the injected clock, via the service's epoch-ms `at`
 *     "requestId": "<correlation id>",
 *     "enterpriseIdHash"?: "<HMAC-SHA256(sessionSecret, enterpriseId), 16 hex>", // reveal only
 *     "resultCount"?: <number>       // search only
 *   }
 * There is deliberately NO field for a name, phone, email, address, raw Enterprise ID or token.
 * The Enterprise ID is present only as the keyed HMAC computed upstream (Req 14.10), so the audit
 * trail can be correlated to a guest by an operator holding the key, but the file alone never
 * identifies a person. The service builds the `AuditEvent`; this module only projects it onto the
 * wire schema and writes it — it adds no data it was not given, so it cannot leak what it never
 * receives.
 *
 * ## Implementations
 *   - {@link FileAuditLogger} — a pino instance on a file (or any injected) destination. Creates the
 *     parent directory if missing (the default `logs/` is git-ignored). Append semantics come from
 *     pino's file transport, so repeated process runs accumulate lines rather than truncating.
 *   - {@link NoopAuditLogger} — discards events; the service's default when no audit sink is wired.
 *   - {@link BufferAuditLogger} — keeps events in memory for assertions; the test double.
 * All three satisfy the service's `AuditLogger` interface, so the service never knows which it has.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import pino, { type Logger } from 'pino';

import type { AuditEvent, AuditLogger } from '../services/guestSearchService.js';

/** The on-the-wire audit record. This is the exact JSON shape written to the audit log. */
export interface AuditRecord {
  /** Fixed discriminator so audit lines are trivially filtered from a mixed stream. */
  readonly event: 'audit';
  /** The audited operation. */
  readonly action: AuditEvent['event'];
  /** The acting colleague's principal id (never the guest). */
  readonly who: string;
  /** ISO 8601 UTC timestamp, derived from the event's epoch-ms `at`. */
  readonly when: string;
  /** Correlation id shared with the app log and the `X-Request-ID` header. */
  readonly requestId: string;
  /** Keyed HMAC of the Enterprise ID (reveal events only); never a plaintext identifier. */
  readonly enterpriseIdHash?: string;
  /** Result count (search events only). */
  readonly resultCount?: number;
}

/**
 * Project a service `AuditEvent` onto the wire {@link AuditRecord}. Pure and total: it copies only
 * the whitelisted fields, converts `at` (epoch ms) to an ISO 8601 UTC string, and attaches
 * `enterpriseIdHash` / `resultCount` only when present. No field outside the schema can appear.
 */
export function toAuditRecord(event: AuditEvent): AuditRecord {
  return {
    event: 'audit',
    action: event.event,
    who: event.principalId,
    when: new Date(event.at).toISOString(),
    requestId: event.requestId,
    ...(event.enterpriseIdHash !== undefined && { enterpriseIdHash: event.enterpriseIdHash }),
    ...(event.resultCount !== undefined && { resultCount: event.resultCount }),
  };
}

/**
 * A no-op audit sink: discards every event. The service's default when audit is not wired. The
 * `record` method takes no named parameter (it ignores the event); it still satisfies the
 * `AuditLogger` interface, since a method accepting fewer parameters is assignable to one that
 * accepts more.
 */
export class NoopAuditLogger implements AuditLogger {
  record(): void {
    // intentionally empty: the event is accepted and discarded.
  }
}

/**
 * An in-memory audit sink for tests: records each projected {@link AuditRecord} so a test can
 * assert the exact events, their order and their (PII-free) fields.
 */
export class BufferAuditLogger implements AuditLogger {
  /** The records written so far, in order. */
  readonly records: AuditRecord[] = [];

  record(event: AuditEvent): void {
    this.records.push(toAuditRecord(event));
  }
}

/** Options for {@link FileAuditLogger}. The destination is injectable for deterministic tests. */
export interface FileAuditLoggerOptions {
  /** Target path for the JSON-lines audit file (e.g. `logs/audit.jsonl`). */
  readonly path: string;
  /**
   * A pre-built pino instance to write through. Tests pass one bound to an in-memory stream so
   * no file is touched; production omits it and a file-backed instance is created from `path`.
   */
  readonly logger?: Logger;
}

/**
 * File-backed audit logger: writes one JSON line per event to `path` (append), using a dedicated
 * pino instance. The parent directory is created if absent. Writes are synchronous (`sync: true`)
 * so an audit record is durable before the reveal/search response returns — losing an audit line
 * on a crash would defeat the trail.
 */
export class FileAuditLogger implements AuditLogger {
  private readonly logger: Logger;

  constructor(options: FileAuditLoggerOptions) {
    this.logger = options.logger ?? createFileAuditPino(options.path);
  }

  record(event: AuditEvent): void {
    const rec = toAuditRecord(event);
    // The record is the full line; the pino message is a stable string for human scanning.
    this.logger.info(rec, rec.action);
  }
}

/**
 * Create the dedicated pino instance for the audit file. ISO UTC time matches the app logger; no
 * redaction is configured because {@link toAuditRecord} is the allow-list — only schema fields
 * ever reach this instance, so there is nothing to redact. The destination is a synchronous file
 * stream so each line is flushed before the call returns.
 */
function createFileAuditPino(path: string): Logger {
  const dir = dirname(path);
  if (dir !== '' && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return pino(
    { base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({ dest: path, sync: true, mkdir: true }),
  );
}
