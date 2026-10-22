// Audit logger (task 9.1; design.md "apps/bff — observability" → audit.ts; Req 22.5, 14.10).
//
// The audit trail records WHO searched / revealed and WHEN, never a contact value. These tests
// prove the exact wire schema, that one JSON line is written per event, that lines ACCUMULATE
// across events (append), that an injected Enterprise-ID HMAC is carried while raw PII never is,
// and that the no-op and buffer doubles behave. The file-backed path is exercised both through an
// injected in-memory pino instance (fast, no disk) and once against a real temp file to prove the
// directory is created and NDJSON is appended.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import pino, { type DestinationStream } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BufferAuditLogger,
  FileAuditLogger,
  NoopAuditLogger,
  toAuditRecord,
  type AuditRecord,
} from '../../../src/observability/audit.js';
import type { AuditEvent, AuditLogger } from '../../../src/services/guestSearchService.js';

const WHEN_MS = Date.UTC(2026, 9, 21, 12, 0, 0); // 2026-10-21T12:00:00.000Z
const WHEN_ISO = '2026-10-21T12:00:00.000Z';

const SEARCH_EVENT: AuditEvent = {
  event: 'guest.search',
  principalId: 'dev-jane.doe',
  requestId: 'req-search-1',
  at: WHEN_MS,
  resultCount: 3,
};

const REVEAL_EVENT: AuditEvent = {
  event: 'guest.reveal',
  principalId: 'dev-jane.doe',
  requestId: 'req-reveal-1',
  at: WHEN_MS,
  enterpriseIdHash: 'a1b2c3d4e5f60718',
};

/** A pino destination that keeps each written line for assertions. */
function sink(): DestinationStream & { records(): AuditRecord[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return Object.assign(stream as unknown as DestinationStream, {
    records: (): AuditRecord[] =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as AuditRecord),
  });
}

describe('toAuditRecord — wire schema (Req 14.10, 22.5)', () => {
  it('projects a search event to who/when/requestId/action/resultCount', () => {
    expect(toAuditRecord(SEARCH_EVENT)).toEqual({
      event: 'audit',
      action: 'guest.search',
      who: 'dev-jane.doe',
      when: WHEN_ISO,
      requestId: 'req-search-1',
      resultCount: 3,
    });
  });

  it('projects a reveal event with the Enterprise-ID HMAC and no result count', () => {
    const rec = toAuditRecord(REVEAL_EVENT);
    expect(rec).toEqual({
      event: 'audit',
      action: 'guest.reveal',
      who: 'dev-jane.doe',
      when: WHEN_ISO,
      requestId: 'req-reveal-1',
      enterpriseIdHash: 'a1b2c3d4e5f60718',
    });
    expect(rec).not.toHaveProperty('resultCount');
  });

  it('omits optional fields when absent (search has no hash, reveal no count)', () => {
    expect(toAuditRecord(SEARCH_EVENT)).not.toHaveProperty('enterpriseIdHash');
    expect(toAuditRecord(REVEAL_EVENT)).not.toHaveProperty('resultCount');
  });

  it('carries no raw identifier or contact field', () => {
    const rec = toAuditRecord(REVEAL_EVENT) as unknown as Record<string, unknown>;
    for (const forbidden of [
      'enterpriseId',
      'email',
      'emails',
      'phone',
      'phones',
      'firstName',
      'lastName',
      'address',
      'addresses',
    ]) {
      expect(rec).not.toHaveProperty(forbidden);
    }
  });
});

describe('NoopAuditLogger', () => {
  it('accepts events (through the interface) and does nothing', () => {
    // Typed as the interface so the call carries the event the service would pass.
    const noop: AuditLogger = new NoopAuditLogger();
    expect(() => {
      noop.record(SEARCH_EVENT);
      noop.record(REVEAL_EVENT);
    }).not.toThrow();
  });
});

describe('BufferAuditLogger', () => {
  it('records projected records in order for assertions', () => {
    const buffer = new BufferAuditLogger();
    buffer.record(SEARCH_EVENT);
    buffer.record(REVEAL_EVENT);
    expect(buffer.records).toEqual([toAuditRecord(SEARCH_EVENT), toAuditRecord(REVEAL_EVENT)]);
  });
});

describe('FileAuditLogger — through an injected pino instance', () => {
  it('writes exactly one JSON line per event with the right fields', () => {
    const dest = sink();
    const logger = pino({ base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, dest);
    const audit = new FileAuditLogger({ path: 'unused.jsonl', logger });

    audit.record(SEARCH_EVENT);

    const records = dest.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'audit',
      action: 'guest.search',
      who: 'dev-jane.doe',
      when: WHEN_ISO,
      requestId: 'req-search-1',
      resultCount: 3,
    });
  });

  it('appends one line per event across multiple events, in order', () => {
    const dest = sink();
    const logger = pino({ base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, dest);
    const audit = new FileAuditLogger({ path: 'unused.jsonl', logger });

    audit.record(SEARCH_EVENT);
    audit.record(REVEAL_EVENT);
    audit.record({ ...SEARCH_EVENT, requestId: 'req-search-2', resultCount: 0 });

    const records = dest.records();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.action)).toEqual(['guest.search', 'guest.reveal', 'guest.search']);
    expect(records.map((r) => r.requestId)).toEqual([
      'req-search-1',
      'req-reveal-1',
      'req-search-2',
    ]);
  });

  it('never writes a contact value or raw Enterprise ID', () => {
    const dest = sink();
    const logger = pino({ base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, dest);
    const audit = new FileAuditLogger({ path: 'unused.jsonl', logger });
    audit.record(REVEAL_EVENT);
    audit.record(SEARCH_EVENT);

    const raw = JSON.stringify(dest.records());
    // The HMAC is present; no plaintext identifier or contact token is.
    expect(raw).toContain('a1b2c3d4e5f60718');
    expect(raw).not.toContain('example.test');
    expect(raw).not.toContain('@');
  });
});

describe('FileAuditLogger — real file destination', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates the parent directory and appends NDJSON to the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-audit-'));
    // A nested, not-yet-existing subdirectory proves mkdir-on-create.
    const path = join(dir, 'nested', 'audit.jsonl');
    const audit = new FileAuditLogger({ path });

    audit.record(SEARCH_EVENT);
    audit.record(REVEAL_EVENT);

    const content = readFileSync(path, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as AuditRecord);
    expect(parsed.map((r) => r.action)).toEqual(['guest.search', 'guest.reveal']);
    expect(parsed[1]?.enterpriseIdHash).toBe('a1b2c3d4e5f60718');
    // No contact value made it to disk.
    expect(content).not.toContain('example.test');
  });
});
