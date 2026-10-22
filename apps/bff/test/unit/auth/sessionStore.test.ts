// MemorySessionStore lifecycle and timeouts (task 8.2, Req 20.10).
// The clock and ID generator are injected so creation, expiry and sliding are deterministic.
import { describe, expect, it } from 'vitest';
import {
  MemorySessionStore,
  defaultIdGenerator,
  type SessionStore,
} from '../../../src/auth/sessionStore.js';

const IDLE_MS = 30 * 60 * 1000; // 30 minutes
const ABSOLUTE_MS = 8 * 60 * 60 * 1000; // 8 hours

/** A store with a mutable fake clock and a deterministic, counting ID generator. */
function makeStore(startMs = 1_000_000): {
  store: SessionStore;
  tick: (ms: number) => void;
  at: (ms: number) => void;
} {
  let now = startMs;
  let counter = 0;
  const store = new MemorySessionStore({
    ttlMs: IDLE_MS,
    absoluteMs: ABSOLUTE_MS,
    now: () => now,
    idGenerator: () => `id-${String(++counter)}`,
  });
  return {
    store,
    tick: (ms) => {
      now += ms;
    },
    at: (ms) => {
      now = ms;
    },
  };
}

describe('MemorySessionStore.create', () => {
  it('creates a session bound to the principal with timestamps from the clock', () => {
    const { store } = makeStore(5_000);
    const record = store.create('dev-jane.doe');
    expect(record).toEqual({
      id: 'id-1',
      createdAt: 5_000,
      lastSeen: 5_000,
      principalId: 'dev-jane.doe',
    });
  });

  it('issues a distinct ID per session', () => {
    const { store } = makeStore();
    const a = store.create('p1');
    const b = store.create('p2');
    expect(a.id).not.toBe(b.id);
    expect(store.get(a.id)?.principalId).toBe('p1');
    expect(store.get(b.id)?.principalId).toBe('p2');
  });
});

describe('MemorySessionStore.get', () => {
  it('returns the session within the idle window', () => {
    const { store, tick } = makeStore();
    const { id } = store.create('p');
    tick(IDLE_MS - 1);
    expect(store.get(id)?.id).toBe(id);
  });

  it('slides the idle clock on activity so continuous use survives past one idle window', () => {
    const { store, tick } = makeStore();
    const { id, createdAt } = store.create('p');
    // Touch just before each idle deadline, staying within the 8 h absolute cap.
    for (let i = 0; i < 10; i++) {
      tick(IDLE_MS - 1);
      const live = store.get(id);
      expect(live).not.toBeNull();
      expect(live?.lastSeen).toBeGreaterThan(createdAt);
    }
    // Total elapsed (~5 h) is well past a single idle window but under the absolute cap.
    expect(store.get(id)).not.toBeNull();
  });

  it('expires after the idle timeout with no activity, and removes the entry', () => {
    const { store, tick } = makeStore();
    const { id } = store.create('p');
    tick(IDLE_MS);
    expect(store.get(id)).toBeNull();
    // Removed: a second look is still null and does not resurrect it.
    expect(store.get(id)).toBeNull();
  });

  it('expires at the absolute cap even while active', () => {
    const { store, tick } = makeStore();
    const { id } = store.create('p');
    // Slide idle repeatedly, but the absolute cap still fires.
    let elapsed = 0;
    const step = IDLE_MS - 1;
    while (elapsed + step < ABSOLUTE_MS) {
      tick(step);
      elapsed += step;
      expect(store.get(id)).not.toBeNull();
    }
    // Cross the absolute deadline; activity cannot save it.
    tick(ABSOLUTE_MS - elapsed);
    expect(store.get(id)).toBeNull();
  });

  it('returns null for an unknown ID', () => {
    const { store } = makeStore();
    expect(store.get('never-issued')).toBeNull();
  });
});

describe('MemorySessionStore.updatePrincipal', () => {
  it('replaces the principal while keeping the same ID and createdAt (persona switch)', () => {
    const { store, tick } = makeStore(2_000);
    const created = store.create('dev-read.only');
    tick(1_000);
    const updated = store.updatePrincipal(created.id, 'dev-jane.doe');
    expect(updated).not.toBeNull();
    expect(updated?.id).toBe(created.id);
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.principalId).toBe('dev-jane.doe');
    expect(store.get(created.id)?.principalId).toBe('dev-jane.doe');
  });

  it('returns null for an unknown or expired session', () => {
    const { store, tick } = makeStore();
    expect(store.updatePrincipal('unknown', 'p')).toBeNull();
    const { id } = store.create('p');
    tick(IDLE_MS);
    expect(store.updatePrincipal(id, 'other')).toBeNull();
  });
});

describe('MemorySessionStore.destroy', () => {
  it('removes a live session so subsequent reads are null', () => {
    const { store } = makeStore();
    const { id } = store.create('p');
    store.destroy(id);
    expect(store.get(id)).toBeNull();
  });

  it('is a no-op for an unknown ID', () => {
    const { store } = makeStore();
    expect(() => {
      store.destroy('unknown');
    }).not.toThrow();
  });
});

describe('defaultIdGenerator', () => {
  it('produces URL-safe IDs with at least 128 bits of entropy and no collisions', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      const id = defaultIdGenerator();
      // base64url of 32 bytes => 43 chars, URL-safe alphabet only.
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeGreaterThanOrEqual(22); // 22 base64url chars ~= 128 bits
      ids.add(id);
    }
    expect(ids.size).toBe(1_000);
  });
});
