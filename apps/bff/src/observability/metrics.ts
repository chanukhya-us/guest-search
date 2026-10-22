/**
 * Application metrics (task 9.2; design.md "apps/bff — observability" → metrics.ts; Req 22.7,
 * 22.6, 22.11).
 *
 * This module owns the OpenTelemetry instruments the BFF records and the single `Metrics` object
 * that `buildApp` injects into the SOAP gateway, the service and the circuit breaker. It records
 * through the OTel **API** meter (`metrics.getMeter('guest-search-bff')`), never a concrete SDK:
 *
 *   - When no SDK is registered (telemetry exporter `none`, and every unit test that does not
 *     start one), the API returns a no-op meter, so every instrument is a no-op and recording is
 *     free and side-effect-free. This is what makes telemetry "disabled-safe" (Req 22.11): the
 *     call sites in the gateway/service/breaker always run, with zero overhead when off.
 *   - When `startTelemetry` has registered a `MeterProvider` (exporter `console` or `otlp`, or a
 *     test that wires an in-memory reader), the same instruments resolve against it and record.
 *
 * ## The instruments (design.md metric list, Req 22.7)
 *
 *   | Name                     | Type              | Unit | Attributes      | Req item          |
 *   |--------------------------|-------------------|------|-----------------|-------------------|
 *   | `gs.http.server.duration`| histogram         | ms   | `outcome`       | inbound duration  |
 *   | `gs.soap.duration`       | histogram         | ms   | `status`        | SOAP duration     |
 *   | `gs.soap.results`        | histogram         | `{result}` | (none)    | result count dist |
 *   | `gs.errors`              | counter           | —    | `code`          | error count/code  |
 *   | `gs.breaker.state`       | observable gauge  | —    | (none)          | breaker state     |
 *
 * The breaker gauge reports `0` closed, `1` half-open, `2` open (design.md). It is an OBSERVABLE
 * gauge: the breaker's own `onStateChange` hook updates an in-memory value here, and the gauge's
 * callback reports the latest value whenever the SDK collects — so a scrape reflects the current
 * state even between transitions, and no state change is lost when export is off.
 *
 * ## Non-PII invariant (Req 22.6, 22.7)
 * Every attribute here is a low-cardinality, non-PII value: an HTTP/outcome label, an upstream
 * status code, or a catalog error code. No criteria field name or value, no contact, no identifier
 * is ever an attribute or a metric name. The `outcome`/`code`/`status` label sets are bounded, so
 * they are safe metric dimensions.
 */
import { ValueType, metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';

import type { GatewayMetrics } from '../soap/soapGuestSearchGateway.js';
import type { ServiceMetrics } from '../services/guestSearchService.js';
import type { BreakerState } from '../soap/circuitBreaker.js';

/** The meter name; matches the service name used for traces and resource `service.name`. */
export const METER_NAME = 'guest-search-bff';

/** Instrument names (design.md metric list). Exported so tests assert the exact names. */
export const METRIC = {
  httpServerDuration: 'gs.http.server.duration',
  soapDuration: 'gs.soap.duration',
  soapResults: 'gs.soap.results',
  errors: 'gs.errors',
  breakerState: 'gs.breaker.state',
} as const;

/** Breaker state → gauge value (design.md: 0 closed, 1 half-open, 2 open). */
const BREAKER_VALUE: Record<BreakerState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/** Inbound-request outcome buckets for `gs.http.server.duration`. */
export type HttpOutcome = 'success' | 'client_error' | 'server_error';

/**
 * The full metrics surface the app records through. It satisfies the collaborator interfaces the
 * gateway (`GatewayMetrics`), the service (`ServiceMetrics`) and the breaker (`onStateChange`)
 * already expect, plus the inbound-HTTP and error hooks the plugin layer calls. One object is
 * built per app and shared, so all instruments live on one meter.
 */
export interface Metrics extends GatewayMetrics, ServiceMetrics {
  /** Record one completed inbound HTTP request (duration ms, outcome bucket). */
  httpServer(durationMs: number, attrs: { outcome: HttpOutcome }): void;
  /** Increment the error counter for a catalog error `code` (no PII). */
  error(attrs: { code: string }): void;
  /** Breaker transition hook — matches `CircuitBreakerDeps.onStateChange`. Never throws. */
  onBreakerState(to: BreakerState, from?: BreakerState): void;
}

/**
 * Build the application `Metrics`. Reads a meter from the OTel API (no-op until an SDK is
 * registered — Req 22.11) and creates every instrument once. The breaker gauge is observable:
 * the latest state is held here and reported by the gauge callback on each collection.
 *
 * @param meter Optional meter override (tests pass a meter from an in-memory `MeterProvider`);
 *   defaults to the global API meter, which is a no-op when telemetry is off.
 */
export function createMetrics(meter: Meter = metrics.getMeter(METER_NAME)): Metrics {
  const httpServerDuration: Histogram = meter.createHistogram(METRIC.httpServerDuration, {
    description: 'Inbound HTTP request duration',
    unit: 'ms',
    valueType: ValueType.DOUBLE,
  });
  const soapDuration: Histogram = meter.createHistogram(METRIC.soapDuration, {
    description: 'SOAP searchGuest call duration',
    unit: 'ms',
    valueType: ValueType.DOUBLE,
  });
  const soapResults: Histogram = meter.createHistogram(METRIC.soapResults, {
    description: 'SOAP searchGuest result-count distribution',
    unit: '{result}',
    valueType: ValueType.INT,
  });
  const errors: Counter = meter.createCounter(METRIC.errors, {
    description: 'Errors by catalog error code',
    valueType: ValueType.INT,
  });

  // Observable breaker-state gauge. The breaker reports transitions via `onBreakerState`, which
  // updates this value; the gauge callback reports it on every collection, so a scrape always
  // reflects the current state even with no recent transition.
  let breakerValue = BREAKER_VALUE.closed;
  const breakerGauge = meter.createObservableGauge(METRIC.breakerState, {
    description: 'Circuit breaker state (0 closed, 1 half-open, 2 open)',
    valueType: ValueType.INT,
  });
  breakerGauge.addCallback((observer) => {
    observer.observe(breakerValue);
  });

  return {
    // GatewayMetrics.soapCall: one completed HTTP exchange → duration + status.
    soapCall(durationMs, attrs): void {
      soapDuration.record(durationMs, { status: attrs.status });
    },

    // ServiceMetrics.searchCompleted: record the result-count distribution. The `empty` vs
    // `success` outcome is implicit in a recorded count of 0, so no separate dimension is added
    // (keeping the histogram attribute-free and the cardinality minimal).
    searchCompleted(attrs): void {
      soapResults.record(attrs.resultCount);
    },

    // ServiceMetrics.revealAttempted: a failed reveal increments the error counter under a
    // dedicated non-PII code; a success is not an error and is intentionally not counted here.
    revealAttempted(attrs): void {
      if (!attrs.ok) errors.add(1, { code: 'REVEAL_EXPIRED' });
    },

    httpServer(durationMs, attrs): void {
      httpServerDuration.record(durationMs, { outcome: attrs.outcome });
    },

    error(attrs): void {
      errors.add(1, { code: attrs.code });
    },

    onBreakerState(to): void {
      breakerValue = BREAKER_VALUE[to];
    },
  };
}

/**
 * A no-op `Metrics` for tests and callers that want an explicit no-op rather than the API meter's
 * (also no-op) instruments. Recording through this never touches the OTel API at all.
 */
export const NOOP_METRICS: Metrics = {
  soapCall: () => undefined,
  searchCompleted: () => undefined,
  revealAttempted: () => undefined,
  httpServer: () => undefined,
  error: () => undefined,
  onBreakerState: () => undefined,
};
