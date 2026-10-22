// OpenTelemetry startup (task 9.2; design.md "apps/bff — observability" → telemetry.ts; Req 22.6,
// 22.11).
//
// These tests exercise the exporter switch and lifecycle WITHOUT exporting anything or opening a
// socket. `@opentelemetry/sdk-node` and `@fastify/otel` are mocked: the real `NodeSDK` performs
// environment detection and lazily loads instrumentation modules on `start()` (slow, and it pulls
// a transitive package whose ESM build does not resolve under the test runner), so a light double
// lets us assert exactly WHAT `startTelemetry` constructs and that it starts/stops once. The REAL
// exporters, resources and span processors are still imported and constructed by `telemetry.ts`,
// so the switch wiring (console vs OTLP, span processor, metric reader, resource attributes) is
// exercised for real — only the SDK's own start/shutdown and the Fastify instrumentation are
// stubbed. The `none` path must start NOTHING and return a no-op shutdown (Req 22.11).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../src/config.js';

/** Capture what the mocked NodeSDK was constructed with, and its start/shutdown calls. */
const sdkCtor = vi.fn();
const sdkStart = vi.fn();
const sdkShutdown = vi.fn(() => Promise.resolve());

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(config: unknown) {
      sdkCtor(config);
    }
    start(): void {
      sdkStart();
    }
    shutdown(): Promise<void> {
      return sdkShutdown();
    }
  },
}));

const fastifyOtelCtor = vi.fn();
vi.mock('@fastify/otel', () => ({
  FastifyOtelInstrumentation: class {
    constructor(opts: unknown) {
      fastifyOtelCtor(opts);
    }
    plugin(): () => void {
      return () => undefined;
    }
  },
}));

// Import AFTER the mocks are registered so `telemetry.ts` binds to the stubbed modules.
const { startTelemetry, telemetryEnabled, createFastifyOtelPlugin, SERVICE_NAME } =
  await import('../../../src/observability/telemetry.js');

type TelemetryConfig = Pick<AppConfig, 'telemetry' | 'nodeEnv'>;

function config(
  exporter: AppConfig['telemetry']['exporter'],
  otlpEndpoint?: string,
): TelemetryConfig {
  return {
    nodeEnv: 'test',
    telemetry: { exporter, ...(otlpEndpoint !== undefined && { otlpEndpoint }) },
  };
}

describe('telemetryEnabled', () => {
  it('is false only for the none exporter', () => {
    expect(telemetryEnabled(config('none'))).toBe(false);
    expect(telemetryEnabled(config('console'))).toBe(true);
    expect(telemetryEnabled(config('otlp'))).toBe(true);
  });
});

describe('startTelemetry', () => {
  beforeEach(() => {
    sdkCtor.mockClear();
    sdkStart.mockClear();
    sdkShutdown.mockClear();
  });

  afterEach(async () => {
    // Leave no running singleton for the next test (startTelemetry guards a double-start).
    // Calling shutdown on a torn-down/no-op handle is safe.
  });

  it('exporter none starts no SDK and returns a no-op shutdown (Req 22.11)', async () => {
    const telemetry = startTelemetry(config('none'));
    expect(sdkCtor).not.toHaveBeenCalled();
    expect(sdkStart).not.toHaveBeenCalled();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(sdkShutdown).not.toHaveBeenCalled();
  });

  it('exporter console starts a NodeSDK with a span processor and a metric reader', async () => {
    const telemetry = startTelemetry(config('console'));
    expect(sdkStart).toHaveBeenCalledTimes(1);
    const built = sdkCtor.mock.calls[0]?.[0] as Record<string, unknown>;
    // Console path uses explicit span processors (not a traceExporter).
    expect(Array.isArray(built['spanProcessors'])).toBe(true);
    expect(built['traceExporter']).toBeUndefined();
    expect(Array.isArray(built['metricReaders'])).toBe(true);
    // Resource carries the service name (non-PII).
    expect(built['resource']).toBeDefined();
    await telemetry.shutdown();
    expect(sdkShutdown).toHaveBeenCalledTimes(1);
  });

  it('exporter otlp starts a NodeSDK with a trace exporter and a metric reader', async () => {
    const telemetry = startTelemetry(config('otlp', 'http://localhost:4318'));
    expect(sdkStart).toHaveBeenCalledTimes(1);
    const built = sdkCtor.mock.calls[0]?.[0] as Record<string, unknown>;
    // OTLP path configures a traceExporter (batched by the SDK default) and a metric reader.
    expect(built['traceExporter']).toBeDefined();
    expect(built['spanProcessors']).toBeUndefined();
    expect(Array.isArray(built['metricReaders'])).toBe(true);
    await telemetry.shutdown();
  });

  it('exporter otlp without a configured endpoint still starts (SDK/env default endpoint)', async () => {
    const telemetry = startTelemetry(config('otlp'));
    expect(sdkStart).toHaveBeenCalledTimes(1);
    const built = sdkCtor.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(built['traceExporter']).toBeDefined();
    expect(Array.isArray(built['metricReaders'])).toBe(true);
    await telemetry.shutdown();
  });

  it('otlp endpoint with a trailing slash is normalised before appending the signal path', async () => {
    const telemetry = startTelemetry(config('otlp', 'http://collector:4318/'));
    expect(sdkStart).toHaveBeenCalledTimes(1);
    await telemetry.shutdown();
  });

  it('is idempotent: a second start while running returns the same handle', async () => {
    const first = startTelemetry(config('console'));
    const second = startTelemetry(config('console'));
    expect(second).toBe(first);
    expect(sdkCtor).toHaveBeenCalledTimes(1);
    await first.shutdown();
  });

  it('can start again after shutdown clears the singleton', async () => {
    const first = startTelemetry(config('console'));
    await first.shutdown();
    const second = startTelemetry(config('console'));
    expect(second).not.toBe(first);
    expect(sdkCtor).toHaveBeenCalledTimes(2);
    await second.shutdown();
  });
});

describe('createFastifyOtelPlugin', () => {
  it('builds the Fastify instrumentation with the service name and a plugin() factory', () => {
    fastifyOtelCtor.mockClear();
    const instrumentation = createFastifyOtelPlugin();
    expect(fastifyOtelCtor).toHaveBeenCalledWith(
      expect.objectContaining({ servername: SERVICE_NAME }),
    );
    expect(typeof instrumentation.plugin).toBe('function');
    expect(typeof instrumentation.plugin()).toBe('function');
  });
});
