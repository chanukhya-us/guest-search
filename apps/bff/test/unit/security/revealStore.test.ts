// MemoryRevealStore + token/hash helpers (task 8.3, Req 14.6, 14.9, 14.10, 20.11).
// Clock and token generator are injected so TTL expiry and token values are deterministic.
import type { GuestEmail, GuestPhone } from '@ihg-guest-search/shared';
import { describe, expect, it } from 'vitest';

import {
  MemoryRevealStore,
  type RevealStore,
  defaultTokenGenerator,
  hashEnterpriseId,
} from '../../../src/security/revealStore.js';

const TTL_MS = 10 * 60 * 1000; // 10 minutes (Req 14.6 default)

const PHONES: GuestPhone[] = [{ number: '+1 404 555 0101', type: 'M', profileDefault: true }];
const EMAILS: GuestEmail[] = [{ address: 'alex@example.test', profileDefault: true }];

/** A store with a mutable fake clock and a deterministic, counting token generator. */
function makeStore(startMs = 1_000_000): { store: RevealStore; tick: (ms: number) => void } {
  let now = startMs;
  let counter = 0;
  const store = new MemoryRevealStore({
    ttlMs: TTL_MS,
    now: () => now,
    idGenerator: () => `rt_test-${String(++counter)}`,
  });
  return {
    store,
    tick: (ms) => {
      now += ms;
    },
  };
}

function entryFor(sessionId: string): Parameters<RevealStore['issue']>[0] {
  return {
    sessionId,
    requestId: 'req-1',
    enterpriseIdHash: 'deadbeefdeadbeef',
    phones: PHONES,
    emails: EMAILS,
  };
}

describe('MemoryRevealStore.issue', () => {
  it('returns a fresh token and stores the unmasked contacts for the session', () => {
    const { store } = makeStore();
    const token = store.issue(entryFor('s1'));
    const entry = store.consume(token, 's1');
    expect(entry).not.toBeNull();
    expect(entry?.phones).toEqual(PHONES);
    expect(entry?.emails).toEqual(EMAILS);
    expect(entry?.requestId).toBe('req-1');
  });

  it('issues a distinct token per call', () => {
    const { store } = makeStore();
    const a = store.issue(entryFor('s1'));
    const b = store.issue(entryFor('s1'));
    expect(a).not.toBe(b);
  });
});

describe('MemoryRevealStore.consume (Req 14.9)', () => {
  it('returns the entry within the TTL window for the issuing session', () => {
    const { store, tick } = makeStore();
    const token = store.issue(entryFor('s1'));
    tick(TTL_MS - 1);
    expect(store.consume(token, 's1')).not.toBeNull();
  });

  it('allows re-reveal within the TTL (entry is not deleted on success)', () => {
    const { store, tick } = makeStore();
    const token = store.issue(entryFor('s1'));
    expect(store.consume(token, 's1')).not.toBeNull();
    tick(TTL_MS - 1);
    // Second reveal within the window still works.
    expect(store.consume(token, 's1')).not.toBeNull();
  });

  it('returns null once the token has expired (Req 14.6)', () => {
    const { store, tick } = makeStore();
    const token = store.issue(entryFor('s1'));
    tick(TTL_MS);
    expect(store.consume(token, 's1')).toBeNull();
    // Swept: a second look is still null.
    expect(store.consume(token, 's1')).toBeNull();
  });

  it('returns null for an unknown token', () => {
    const { store } = makeStore();
    expect(store.consume('rt_never-issued', 's1')).toBeNull();
  });

  it('rejects a token presented by a different session (Req 14.9)', () => {
    const { store } = makeStore();
    const token = store.issue(entryFor('s1'));
    // A valid, live token, but the wrong session: indistinguishable from unknown/expired.
    expect(store.consume(token, 's2')).toBeNull();
    // The real owner can still consume it afterwards.
    expect(store.consume(token, 's1')).not.toBeNull();
  });
});

describe('MemoryRevealStore.dropSession (Req 20.11)', () => {
  it('removes every entry for the session on logout', () => {
    const { store } = makeStore();
    const t1 = store.issue(entryFor('s1'));
    const t2 = store.issue(entryFor('s1'));
    store.dropSession('s1');
    expect(store.consume(t1, 's1')).toBeNull();
    expect(store.consume(t2, 's1')).toBeNull();
  });

  it('leaves other sessions untouched', () => {
    const { store } = makeStore();
    const t1 = store.issue(entryFor('s1'));
    const t2 = store.issue(entryFor('s2'));
    store.dropSession('s1');
    expect(store.consume(t1, 's1')).toBeNull();
    expect(store.consume(t2, 's2')).not.toBeNull();
  });

  it('is a no-op for a session with no entries', () => {
    const { store } = makeStore();
    expect(() => {
      store.dropSession('unknown');
    }).not.toThrow();
  });
});

describe('defaultTokenGenerator', () => {
  it('produces opaque rt_ tokens with high entropy, URL-safe and collision-free', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      const token = defaultTokenGenerator();
      expect(token).toMatch(/^rt_[A-Za-z0-9_-]+$/);
      // 24 bytes -> 32 base64url chars, plus the 'rt_' prefix.
      expect(token.length).toBe('rt_'.length + 32);
      tokens.add(token);
    }
    expect(tokens.size).toBe(1_000);
  });

  it('carries no PII and no guessable structure', () => {
    const token = defaultTokenGenerator();
    // Only the fixed prefix and base64url payload — nothing derived from input data.
    expect(token.slice(3)).not.toContain('@');
    expect(token.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('hashEnterpriseId (Req 14.10)', () => {
  it('is a deterministic 16-hex-char HMAC of the enterprise ID', () => {
    const h = hashEnterpriseId('session-secret-value', '900000001');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashEnterpriseId('session-secret-value', '900000001')).toBe(h);
  });

  it('does not contain the plaintext enterprise ID', () => {
    const h = hashEnterpriseId('session-secret-value', '900000001');
    expect(h).not.toContain('900000001');
  });

  it('changes with the key (keyed, not a stable cross-deployment identifier)', () => {
    const a = hashEnterpriseId('secret-a', '900000001');
    const b = hashEnterpriseId('secret-b', '900000001');
    expect(a).not.toBe(b);
  });

  it('distinguishes different enterprise IDs under the same key', () => {
    const a = hashEnterpriseId('k', '900000001');
    const b = hashEnterpriseId('k', '900000002');
    expect(a).not.toBe(b);
  });
});
