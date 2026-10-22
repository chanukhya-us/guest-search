/**
 * Circuit breaker for the SOAP transport (Req 10.7, design.md "transport.ts + circuitBreaker.ts").
 *
 * closed → open → half-open, driven by an injected clock (no timers):
 *   - Only `UPSTREAM_TIMEOUT` and `UPSTREAM_UNAVAILABLE` count as failures. After
 *     `failureThreshold` consecutive counted failures the circuit opens for `openMs`.
 *   - While open, `exec` throws `SoapError('UPSTREAM_UNAVAILABLE', CIRCUIT_OPEN)` without
 *     calling `fn`. The detail lets logs tell a fail-fast apart from a real outage.
 *   - The state is computed lazily: open becomes half-open once `now() >= openedAt + openMs`.
 *   - Half-open admits exactly one trial call; concurrent calls during the trial fail fast.
 *     Trial success closes the circuit; a counted trial failure reopens it for `openMs`.
 *
 * Non-counted errors always pass through unchanged. Choice for the failure counter:
 *   - A non-counted `SoapError` (FAULT, HTTP_ERROR, MALFORMED, CONTRACT, TXN_FAILED) means
 *     the service answered, which proves reachability: it is treated like a success and
 *     resets the counter (and closes a half-open circuit).
 *   - Any other error (a programming bug, not an upstream outcome) is neutral: the counter is
 *     unchanged and a half-open circuit stays half-open, so the next call becomes the trial.
 */
import type { AppConfig } from '../config.js';
import { SoapError, type UpstreamCode } from './responseParser.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

/** `SoapError.detail` of a fail-fast rejection. */
export const CIRCUIT_OPEN = 'CIRCUIT_OPEN';

const COUNTED: ReadonlySet<UpstreamCode> = new Set(['UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE']);

export interface CircuitBreakerDeps {
  /** Milliseconds clock; defaults to `Date.now`. */
  now?: () => number;
  /** Called on every observed transition (metrics hook, task 9.2). Must not throw. */
  onStateChange?: (to: BreakerState, from: BreakerState) => void;
}

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #openMs: number;
  readonly #now: () => number;
  readonly #onStateChange: ((to: BreakerState, from: BreakerState) => void) | undefined;

  #failures = 0;
  #openedAt: number | null = null;
  #trialInFlight = false;
  #observed: BreakerState = 'closed';

  constructor(cfg: AppConfig['soap']['breaker'], deps: CircuitBreakerDeps = {}) {
    this.#threshold = cfg.failureThreshold;
    this.#openMs = cfg.openMs;
    this.#now = deps.now ?? Date.now;
    this.#onStateChange = deps.onStateChange;
  }

  /** Current state, computed from the clock. */
  get state(): BreakerState {
    return this.#sync();
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.#sync();
    if (state === 'open' || (state === 'half-open' && this.#trialInFlight)) {
      throw new SoapError('UPSTREAM_UNAVAILABLE', CIRCUIT_OPEN);
    }
    const trial = state === 'half-open';
    if (trial) this.#trialInFlight = true;
    try {
      const result = await fn();
      this.#close();
      return result;
    } catch (e) {
      if (e instanceof SoapError) {
        if (COUNTED.has(e.code)) this.#fail();
        else this.#close();
      }
      throw e;
    } finally {
      if (trial) this.#trialInFlight = false;
    }
  }

  #close(): void {
    this.#failures = 0;
    this.#openedAt = null;
    this.#sync();
  }

  #fail(): void {
    this.#failures += 1;
    // A half-open trial failure reopens straight away; closed needs the full threshold.
    if (this.#openedAt !== null || this.#failures >= this.#threshold) {
      this.#openedAt = this.#now();
    }
    this.#sync();
  }

  /** Compute the state and report a transition if it differs from the last one observed. */
  #sync(): BreakerState {
    let state: BreakerState = 'closed';
    if (this.#openedAt !== null) {
      state = this.#now() >= this.#openedAt + this.#openMs ? 'half-open' : 'open';
    }
    if (state !== this.#observed) {
      const from = this.#observed;
      this.#observed = state;
      this.#onStateChange?.(state, from);
    }
    return state;
  }
}
