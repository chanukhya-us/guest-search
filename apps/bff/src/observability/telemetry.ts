/**
 * OpenTelemetry startup (task 9.2; design.md "apps/bff — observability" → telemetry.ts; Req 22.6,
 * 22.11).
 *
 * `startTelemetry(config)` is called once by the server entry point (`index.ts`) BEFORE the app is
 * built, so the SDK's auto-instrumentations (HTTP, undici) patch the runtime before Fastify and
 * undici are first used. It returns a `Telemetry` handle whose `shutdown()` flushes and stops the
 * SDK; the entry point calls it on SIGINT/SIGTERM alongside `app.close()`.
 *
 * ## Exporter switch (design.md config, Req 22.6)
 *   - `none`    — the default. No SDK is started; the global trace/metric API stays a no-op, so
 *                 every span and instrument in the app is free and side-effect-free. `shutdown()`
 *                 is a no-op. This is the "disabled-safe" path (Req 22.11) and the test default:
 *                 no SDK, no exporter, no network, zero overhead.
 *   - `console` — start a `NodeSDK` with console span and metric exporters (local debugging).
 *   - `otlp`    — start a `NodeSDK` with OTLP/HTTP span and metric exporters. The endpoint comes
 *                 from `config.telemetry.otlpEndpoint`; the OTLP exporters also honour the standard
 *                 `OTEL_EXPORTER_OTLP_ENDPOINT` env var when the config value is absent.
 *
 * Construction only configures the exporters — it never opens a connection. An OTLP exporter dials
 * lazily on first export, so building the SDK (and immediately shutting it down) performs no
 * network I/O, which is what lets the `otlp` path be unit-tested without a collector.
 *
 * ## Resource and instrumentations
 * The SDK is given a Resource carrying `service.name = guest-search-bff` and
 * `deployment.environment.name = <nodeEnv>` (non-PII), merged onto the default resource. The
 * registered instrumentations are HTTP and undici with request/response BODY capture disabled
 * (Req 22.6: no payloads, no PII in spans). Fastify tracing is wired separately as a Fastify plugin
 * — see `telemetryPlugin` below and the wiring note.
 *
 * ## Idempotency
 * `startTelemetry` guards a module-level singleton: a second call while an SDK is running returns
 * the same handle instead of starting a second SDK (which would throw on a duplicate global
 * provider). `shutdown()` clears the singleton so a later start can create a fresh SDK (used by
 * tests that start/stop around each case).
 *
 * ## @fastify/otel wiring decision
 * `@fastify/otel` MUST register as a Fastify plugin (it hooks the Fastify request lifecycle); it
 * cannot be a NodeSDK auto-instrumentation. `startTelemetry` therefore registers only HTTP+undici
 * on the SDK, and exposes `createFastifyOtelPlugin()` so `buildApp` can register the Fastify
 * instrumentation plugin ONLY when the exporter is not `none`. `buildApp` makes that call behind a
 * `config.telemetry.exporter !== 'none'` guard and a DYNAMIC import of this module, so with the
 * exporter off this whole OpenTelemetry dependency graph is never loaded — the plugin is skipped
 * and adds no overhead. (`telemetryEnabled` is retained as the equivalent predicate for callers.)
 */
import { FastifyOtelInstrumentation, type FastifyOtelInstrumentationOpts } from '@fastify/otel';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes, defaultResource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';

import type { AppConfig } from '../config.js';

/** The `service.name` on every span and metric; matches the meter and logger service name. */
export const SERVICE_NAME = 'guest-search-bff';

// Resource attribute keys (OpenTelemetry semantic conventions). Inlined as the stable string
// literals rather than imported from `@opentelemetry/semantic-conventions`, whose ESM build uses a
// directory subpath import that Node/Vitest cannot resolve. The keys are part of the stable
// convention, so the literals are safe and version-independent.
const ATTR_SERVICE_NAME = 'service.name';
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

/** A started-telemetry handle. `shutdown` flushes and stops the SDK; it is safe to call once. */
export interface Telemetry {
  /** Stop the SDK and flush pending spans/metrics. No-op when nothing was started. */
  shutdown(): Promise<void>;
}

/** A `Telemetry` that did nothing (exporter `none`): shutdown resolves immediately. */
const NOOP_TELEMETRY: Telemetry = { shutdown: () => Promise.resolve() };

/** The single running SDK (idempotency guard). Null when telemetry is off/not started. */
let active: { sdk: NodeSDK; telemetry: Telemetry } | null = null;

/** True when the exporter config asks for a running SDK (anything but `none`). */
export function telemetryEnabled(config: Pick<AppConfig, 'telemetry'>): boolean {
  return config.telemetry.exporter !== 'none';
}

/**
 * Start the OpenTelemetry SDK according to `config.telemetry.exporter`. Returns a handle whose
 * `shutdown()` stops it. With exporter `none` (the default and the test default) nothing is
 * started and a no-op handle is returned. Idempotent: a second call while running returns the
 * existing handle.
 */
export function startTelemetry(config: Pick<AppConfig, 'telemetry' | 'nodeEnv'>): Telemetry {
  if (active !== null) return active.telemetry;
  if (!telemetryEnabled(config)) return NOOP_TELEMETRY;

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.nodeEnv,
    }),
  );

  const sdk = new NodeSDK({
    resource,
    // Console uses a SimpleSpanProcessor for immediate output; OTLP uses the SDK's default batch
    // processor around the OTLP exporter (configured via `traceExporter`).
    ...(config.telemetry.exporter === 'console'
      ? { spanProcessors: [new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() })] }
      : { traceExporter: new OTLPTraceExporter(otlpTraceOptions(config)) }),
    metricReaders: [metricReader(config)],
    // Capture inbound/outbound HTTP spans; Fastify tracing is a plugin (see module doc). Request
    // and response bodies are never captured (Req 22.6 — no payloads, no PII in spans).
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });

  sdk.start();

  const telemetry: Telemetry = {
    shutdown: async (): Promise<void> => {
      active = null;
      await sdk.shutdown();
    },
  };
  active = { sdk, telemetry };
  return telemetry;
}

/** The metric reader for the selected exporter (console or OTLP), exporting periodically. */
function metricReader(config: Pick<AppConfig, 'telemetry'>): MetricReader {
  const exporter =
    config.telemetry.exporter === 'console'
      ? new ConsoleMetricExporter()
      : new OTLPMetricExporter(otlpMetricOptions(config));
  return new PeriodicExportingMetricReader({ exporter });
}

/** OTLP trace exporter options: an explicit endpoint when configured, else the SDK/env default. */
function otlpTraceOptions(config: Pick<AppConfig, 'telemetry'>): { url?: string } {
  const endpoint = config.telemetry.otlpEndpoint;
  return endpoint === undefined ? {} : { url: `${trimSlash(endpoint)}/v1/traces` };
}

/** OTLP metric exporter options: an explicit endpoint when configured, else the SDK/env default. */
function otlpMetricOptions(config: Pick<AppConfig, 'telemetry'>): { url?: string } {
  const endpoint = config.telemetry.otlpEndpoint;
  return endpoint === undefined ? {} : { url: `${trimSlash(endpoint)}/v1/metrics` };
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Build the `@fastify/otel` instrumentation plugin for `buildApp` to register. Call ONLY when
 * `telemetryEnabled(config)` is true — with the exporter off there is no provider and the plugin
 * is skipped. Server-name attribution and body capture follow the SDK defaults (no bodies).
 */
export function createFastifyOtelPlugin(
  opts: FastifyOtelInstrumentationOpts = {},
): FastifyOtelInstrumentation {
  // `servername` names the service on Fastify spans at runtime; it is accepted by the plugin but
  // absent from its exported option type, so it is merged through a locally widened type.
  const withServerName: FastifyOtelInstrumentationOpts & { servername: string } = {
    servername: SERVICE_NAME,
    ...opts,
  };
  return new FastifyOtelInstrumentation(withServerName);
}
