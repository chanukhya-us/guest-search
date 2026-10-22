// Application metrics (task 9.2; design.md "apps/bff — observability" → metrics.ts; Req 22.7,
// 22.6, 22.11).
//
// These tests record through a REAL in-memory `MeterProvider` (sdk-metrics) wired to a manual
// `PeriodicExportingMetricReader` + `InMemoryMetricExporter`, so every instrument the app creates
// is collected and asserted by exact name, type and data points. The privacy checks prove that the
// only attributes present are the non-PII labels the design allows (status code, outcome bucket,
// catalog error code) — never a criteria field, contact or identifier. The breaker gauge test
// proves the observable value tracks `onBreakerState` (0 closed, 1 half-open, 2 open).
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  METER_NAME,
  METRIC,
  NOOP_METRICS,
  createMetrics,
  type Metrics,
} from '../../../src/observability/metrics.js';

/** A manual in-memory metrics harness: build `Metrics` on a meter, then `collect()` the data. */
function harness(): {
  metrics: Metrics;
  collect: () => Promise<ResourceMetrics>;
  shutdown: () => Promise<void>;
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // A very long interval so nothing exports on a timer; `reader.collect()` drives it manually.
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 2_147_483_647,
  });
  const provider = new MeterProvider({ readers: [reader] });
  const meter = provider.getMeter(METER_NAME);
  const metrics = createMetrics(meter);
  return {
    metrics,
    collect: async (): Promise<ResourceMetrics> => {
      const result = await reader.collect();
      return result.resourceMetrics;
    },
    shutdown: () => provider.shutdown(),
  };
}

/** Find a collected metric by name across all scope metrics. */
function metricByName(rm: ResourceMetrics, name: string) {
  for (const scope of rm.scopeMetrics) {
    const found = scope.metrics.find((m) => m.descriptor.name === name);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('createMetrics instruments', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('records SOAP call duration under gs.soap.duration with a status attribute only', async () => {
    h.metrics.soapCall(42, { status: 200 });

    const rm = await h.collect();
    const m = metricByName(rm, METRIC.soapDuration);
    expect(m).toBeDefined();
    expect(m?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(m?.descriptor.unit).toBe('ms');
    const point = m?.dataPoints[0];
    expect(point?.attributes).toEqual({ status: 200 });
    // A single recording of 42 lands in exactly one histogram sample.
    const value = point?.value as { count: number; sum: number };
    expect(value.count).toBe(1);
    expect(value.sum).toBe(42);
  });

  it('records the result-count distribution under gs.soap.results with no attributes', async () => {
    h.metrics.searchCompleted({ outcome: 'success', resultCount: 7 });
    h.metrics.searchCompleted({ outcome: 'empty', resultCount: 0 });

    const rm = await h.collect();
    const m = metricByName(rm, METRIC.soapResults);
    expect(m).toBeDefined();
    expect(m?.dataPointType).toBe(DataPointType.HISTOGRAM);
    const point = m?.dataPoints[0];
    expect(point?.attributes).toEqual({});
    const value = point?.value as { count: number; sum: number };
    expect(value.count).toBe(2);
    expect(value.sum).toBe(7);
  });

  it('records inbound HTTP duration under gs.http.server.duration bucketed by outcome', async () => {
    h.metrics.httpServer(10, { outcome: 'success' });
    h.metrics.httpServer(20, { outcome: 'server_error' });

    const rm = await h.collect();
    const m = metricByName(rm, METRIC.httpServerDuration);
    expect(m).toBeDefined();
    expect(m?.dataPointType).toBe(DataPointType.HISTOGRAM);
    const outcomes = m?.dataPoints.map((p) => p.attributes['outcome']).sort();
    expect(outcomes).toEqual(['server_error', 'success']);
  });

  it('counts errors by catalog code under gs.errors', async () => {
    h.metrics.error({ code: 'UPSTREAM_TIMEOUT' });
    h.metrics.error({ code: 'UPSTREAM_TIMEOUT' });
    h.metrics.error({ code: 'VALIDATION_ERROR' });
    h.metrics.revealAttempted({ ok: false });
    h.metrics.revealAttempted({ ok: true }); // not an error — not counted

    const rm = await h.collect();
    const m = metricByName(rm, METRIC.errors);
    expect(m).toBeDefined();
    expect(m?.dataPointType).toBe(DataPointType.SUM);
    const byCode = Object.fromEntries(
      (m?.dataPoints ?? []).map((p) => [p.attributes['code'], p.value]),
    );
    expect(byCode['UPSTREAM_TIMEOUT']).toBe(2);
    expect(byCode['VALIDATION_ERROR']).toBe(1);
    expect(byCode['REVEAL_EXPIRED']).toBe(1);
  });

  it('every recorded attribute is a non-PII label (status/outcome/code only)', async () => {
    h.metrics.soapCall(5, { status: 503 });
    h.metrics.httpServer(5, { outcome: 'client_error' });
    h.metrics.error({ code: 'FORBIDDEN' });
    h.metrics.searchCompleted({ outcome: 'success', resultCount: 1 });

    const rm = await h.collect();
    const allowedKeys = new Set(['status', 'outcome', 'code']);
    for (const scope of rm.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
          for (const key of Object.keys(point.attributes)) {
            expect(allowedKeys.has(key)).toBe(true);
          }
        }
      }
    }
  });

  it('exposes the breaker state as an observable gauge reflecting onBreakerState', async () => {
    // Default (no transition reported) reports closed → 0.
    let rm = await h.collect();
    let gauge = metricByName(rm, METRIC.breakerState);
    expect(gauge).toBeDefined();
    expect(gauge?.dataPointType).toBe(DataPointType.GAUGE);
    expect(gauge?.dataPoints[0]?.value).toBe(0);

    h.metrics.onBreakerState('open', 'closed');
    rm = await h.collect();
    gauge = metricByName(rm, METRIC.breakerState);
    expect(gauge?.dataPoints[0]?.value).toBe(2);

    h.metrics.onBreakerState('half-open', 'open');
    rm = await h.collect();
    gauge = metricByName(rm, METRIC.breakerState);
    expect(gauge?.dataPoints[0]?.value).toBe(1);

    h.metrics.onBreakerState('closed', 'half-open');
    rm = await h.collect();
    gauge = metricByName(rm, METRIC.breakerState);
    expect(gauge?.dataPoints[0]?.value).toBe(0);
  });
});

describe('NOOP_METRICS', () => {
  it('accepts every call without throwing and records nothing', () => {
    expect(() => {
      NOOP_METRICS.soapCall(1, { status: 200 });
      NOOP_METRICS.searchCompleted({ outcome: 'empty', resultCount: 0 });
      NOOP_METRICS.revealAttempted({ ok: false });
      NOOP_METRICS.httpServer(1, { outcome: 'success' });
      NOOP_METRICS.error({ code: 'INTERNAL_ERROR' });
      NOOP_METRICS.onBreakerState('open', 'closed');
    }).not.toThrow();
  });
});

describe('createMetrics with the default (API) meter', () => {
  it('builds without an SDK and recording is a safe no-op (telemetry off, Req 22.11)', () => {
    const metrics = createMetrics();
    expect(() => {
      metrics.soapCall(1, { status: 200 });
      metrics.searchCompleted({ outcome: 'success', resultCount: 3 });
      metrics.httpServer(1, { outcome: 'success' });
      metrics.error({ code: 'UPSTREAM_FAULT' });
      metrics.onBreakerState('open');
    }).not.toThrow();
  });
});
