// Unit tests for the SOAP circuit breaker (task 6.1, Req 10.7). Injected clock, no timers.
// The last block (task 6.4) drives the default `Date.now` clock with Vitest fake timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CIRCUIT_OPEN,
  CircuitBreaker,
  type BreakerState,
} from '../../../src/soap/circuitBreaker.js';
import { SoapError, type UpstreamCode } from '../../../src/soap/responseParser.js';

const OPEN_MS = 30_000;
const THRESHOLD = 3;

function setup() {
  let t = 1_000;
  const changes: [BreakerState, BreakerState][] = [];
  const breaker = new CircuitBreaker(
    { failureThreshold: THRESHOLD, openMs: OPEN_MS },
    { now: () => t, onStateChange: (to, from) => changes.push([to, from]) },
  );
  const advance = (ms: number): void => {
    t += ms;
  };
  return { breaker, changes, advance };
}

const fail = (code: UpstreamCode) => () => Promise.reject(new SoapError(code));
const ok = () => Promise.resolve('ok');

async function tripOpen(breaker: CircuitBreaker): Promise<void> {
  for (let i = 0; i < THRESHOLD; i += 1) {
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow(SoapError);
  }
}

async function expectFailFast(breaker: CircuitBreaker): Promise<void> {
  const fn = vi.fn(ok);
  const err: unknown = await breaker.exec(fn).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SoapError);
  expect(err).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: CIRCUIT_OPEN });
  expect(fn).not.toHaveBeenCalled();
}

describe('CircuitBreaker (Req 10.7)', () => {
  it('starts closed and passes results through', async () => {
    const { breaker, changes } = setup();
    expect(breaker.state).toBe('closed');
    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(changes).toEqual([]);
  });

  it('defaults to the real clock when none is injected', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 60_000 });
    await expect(breaker.exec(fail('UPSTREAM_UNAVAILABLE'))).rejects.toThrow(SoapError);
    expect(breaker.state).toBe('open');
  });

  it('opens after failureThreshold consecutive TIMEOUT/UNAVAILABLE failures', async () => {
    const { breaker } = setup();
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
    await expect(breaker.exec(fail('UPSTREAM_UNAVAILABLE'))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(breaker.state).toBe('closed');
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow(SoapError);
    expect(breaker.state).toBe('open');
  });

  it('a success resets the consecutive-failure counter', async () => {
    const { breaker } = setup();
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    }
    await breaker.exec(ok);
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    }
    expect(breaker.state).toBe('closed');
  });

  it('while open, fails fast with UPSTREAM_UNAVAILABLE / CIRCUIT_OPEN without calling fn', async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    await expectFailFast(breaker);
    advance(OPEN_MS - 1);
    expect(breaker.state).toBe('open');
    await expectFailFast(breaker);
  });

  it('becomes half-open at openedAt + openMs; a successful trial closes it', async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(OPEN_MS);
    expect(breaker.state).toBe('half-open');
    const fn = vi.fn(ok);
    await expect(breaker.exec(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.state).toBe('closed');
    // Fully closed again: it takes the whole threshold to reopen.
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    expect(breaker.state).toBe('closed');
  });

  it('a failed half-open trial reopens it for another openMs', async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(OPEN_MS);
    await expect(breaker.exec(fail('UPSTREAM_UNAVAILABLE'))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(breaker.state).toBe('open');
    await expectFailFast(breaker);
    advance(OPEN_MS - 1);
    expect(breaker.state).toBe('open');
    advance(1);
    expect(breaker.state).toBe('half-open');
  });

  it('half-open admits a single trial; concurrent calls fail fast', async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(OPEN_MS);

    let release!: (v: string) => void;
    const trialFn = vi.fn(() => new Promise<string>((r) => (release = r)));
    const trial = breaker.exec(trialFn);
    expect(trialFn).toHaveBeenCalledTimes(1);

    await expectFailFast(breaker);
    expect(breaker.state).toBe('half-open');

    release('done');
    await expect(trial).resolves.toBe('done');
    expect(breaker.state).toBe('closed');
  });

  it('non-counted SoapErrors pass through and reset the counter (service answered)', async () => {
    const { breaker } = setup();
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    }
    const fault = new SoapError('UPSTREAM_FAULT', 'soap:Server');
    await expect(breaker.exec(() => Promise.reject(fault))).rejects.toBe(fault);
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    expect(breaker.state).toBe('closed');

    // Never opens on non-counted codes alone.
    for (let i = 0; i < THRESHOLD * 2; i += 1) {
      await expect(breaker.exec(fail('UPSTREAM_HTTP_ERROR'))).rejects.toThrow();
    }
    expect(breaker.state).toBe('closed');
  });

  it('a non-counted SoapError on the half-open trial closes the circuit', async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(OPEN_MS);
    await expect(breaker.exec(fail('UPSTREAM_FAULT'))).rejects.toThrow();
    expect(breaker.state).toBe('closed');
  });

  it('non-SoapErrors pass through and are neutral', async () => {
    const { breaker, advance } = setup();
    const bug = new TypeError('boom');
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    }
    await expect(breaker.exec(() => Promise.reject(bug))).rejects.toBe(bug);
    // Counter unchanged: one more counted failure opens it.
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    expect(breaker.state).toBe('open');

    // Half-open stays half-open and the trial slot is released.
    advance(OPEN_MS);
    await expect(breaker.exec(() => Promise.reject(bug))).rejects.toBe(bug);
    expect(breaker.state).toBe('half-open');
    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('reports every transition through onStateChange', async () => {
    const { breaker, changes, advance } = setup();
    await tripOpen(breaker);
    advance(OPEN_MS);
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toThrow();
    advance(OPEN_MS);
    await breaker.exec(ok);
    expect(changes).toEqual([
      ['open', 'closed'],
      ['half-open', 'open'],
      ['open', 'half-open'],
      ['half-open', 'open'],
      ['closed', 'half-open'],
    ]);
  });
});

// Task 6.4: the default clock is `Date.now`, read on every state check. Vitest fake timers
// replace `Date`, so the breaker must be built after `vi.useFakeTimers()` (it captures the
// `Date.now` function at construction). Fake timers are used here only, never with MSW.
describe('CircuitBreaker with the default Date.now clock under fake timers', () => {
  const START = new Date('2026-10-21T12:00:00.000Z');

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeClockBreaker(): CircuitBreaker {
    vi.useFakeTimers({ now: START });
    return new CircuitBreaker({ failureThreshold: THRESHOLD, openMs: OPEN_MS });
  }

  it('opens at the threshold, fails fast, and half-opens after advanceTimersByTime(openMs)', async () => {
    const breaker = fakeClockBreaker();
    await tripOpen(breaker);
    expect(breaker.state).toBe('open');
    await expectFailFast(breaker);

    vi.advanceTimersByTime(OPEN_MS - 1);
    expect(breaker.state).toBe('open');
    await expectFailFast(breaker);

    vi.advanceTimersByTime(1);
    expect(breaker.state).toBe('half-open');
    const fn = vi.fn(ok);
    await expect(breaker.exec(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.state).toBe('closed');
  });

  it('a failed half-open trial reopens for openMs measured from setSystemTime', async () => {
    const breaker = fakeClockBreaker();
    await tripOpen(breaker);

    const trialAt = START.getTime() + OPEN_MS + 5_000; // well past the window
    vi.setSystemTime(trialAt);
    expect(breaker.state).toBe('half-open');
    await expect(breaker.exec(fail('UPSTREAM_TIMEOUT'))).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
    expect(breaker.state).toBe('open');
    await expectFailFast(breaker);

    // The new window starts at the trial failure, not at the first opening.
    vi.setSystemTime(trialAt + OPEN_MS - 1);
    expect(breaker.state).toBe('open');
    vi.setSystemTime(trialAt + OPEN_MS);
    expect(breaker.state).toBe('half-open');
  });
});
