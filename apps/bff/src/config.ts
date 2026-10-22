/**
 * BFF runtime configuration (design.md "apps/bff — configuration").
 *
 * `loadConfig` is called once at startup. It validates the environment with Zod and maps it
 * to `AppConfig`. On failure it throws `StartupError` naming the missing or invalid keys
 * only; values are never echoed (Req 8.5). Secret values (session secret, SOAP service
 * user, SOAP credential) are read only through `SecretProvider` (Req 8.4).
 *
 * Every key is listed in `.env.example`. Empty or whitespace-only values count as unset,
 * so the documented default applies (or the key is reported missing when required).
 */
import { z } from 'zod';
import { StartupError } from './errors.js';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  trustProxy: boolean;
  auth: { mode: 'dev' | 'oidc'; dev?: { userId: string; displayName: string; roles: string[] } };
  /** `ttlMinutes` is the idle timeout; `absoluteHours` caps total session lifetime (Req 20.10). */
  session: { cookieName: string; ttlMinutes: number; absoluteHours: number; secret: string };
  soap: {
    endpoint: URL;
    soapAction: string;
    connectTimeoutMs: number;
    responseTimeoutMs: number;
    maxResponseBytes: number;
    maxResults: number;
    tls?: { caFile?: string; certFile?: string; keyFile?: string };
    features: { addressLine1: boolean; city: boolean; postalCode: boolean };
    header: {
      languageCode: string;
      countryCode: string;
      channel: string;
      subChannel: string;
      environment: string;
      serviceUser: string;
      sequence: number;
      /** Attached only once the contract defines its location (Blockers B5/B6). */
      credential?: string;
    };
    breaker: { failureThreshold: number; openMs: number };
  };
  rateLimit: { searchPerMinute: number; revealPerMinute: number };
  reveal: { ttlMinutes: number };
  ui: {
    scoreBands: { high: number; medium: number };
    memberTypes: { code: string; label: string }[];
  };
  log: { level: LogLevel; auditLogPath: string };
  telemetry: { exporter: 'none' | 'console' | 'otlp'; otlpEndpoint?: string };
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Source of secret values (Req 8.4). Swap for a vault-backed provider outside local dev. */
export interface SecretProvider {
  get(key: string): string | undefined;
}

/** Local-development secret provider: reads environment variables (Req 8.4). */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(key: string): string | undefined {
    return this.env[key];
  }
}

/** Minimum SESSION_SECRET length in characters (e.g. `openssl rand -base64 32` gives 44). */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** Keys resolved through `SecretProvider` rather than the plain environment. */
const SECRET_KEYS = [
  'SESSION_SECRET',
  'SOAP_HEADER_SERVICE_USER',
  'SOAP_SERVICE_CREDENTIAL',
] as const;

// ---------------------------------------------------------------------------------------
// Field schemas. All inputs are strings (or undefined); outputs are typed values.
// ---------------------------------------------------------------------------------------

/** Non-empty text with no control characters (values may land in HTTP or SOAP headers). */
const text = z.string().regex(/^[^\p{Cc}]+$/u);

const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

/** Strict boolean: exactly 'true' or 'false'. */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const httpUrl = z
  .string()
  .refine((s) => URL.canParse(s) && /^https?:$/.test(new URL(s).protocol))
  .transform((s) => new URL(s));

const commaList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0),
  )
  .pipe(z.array(text).min(1));

const memberTypes = z
  .string()
  .transform((s, ctx): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not JSON' });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(z.strictObject({ code: text, label: text }))
      .refine((a) => new Set(a.map((m) => m.code)).size === a.length),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(1, 65535).default(3000),
    TRUST_PROXY: bool.default(false),

    AUTH_MODE: z.enum(['dev', 'oidc']).default('dev'),
    DEV_AUTH_USER_ID: text.default('dev-user-001'),
    DEV_AUTH_DISPLAY_NAME: text.default('Dev Colleague'),
    DEV_AUTH_ROLES: commaList.default(['GuestSearch.Read', 'GuestSearch.RevealPII']),

    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    SESSION_TTL_MINUTES: int(1).default(30),
    SESSION_ABSOLUTE_HOURS: int(1).default(8),
    SESSION_SECRET: z.string().min(MIN_SESSION_SECRET_LENGTH),

    SOAP_ENDPOINT: httpUrl,
    SOAP_ACTION: text,
    SOAP_CONNECT_TIMEOUT_MS: int(1).default(3000),
    SOAP_RESPONSE_TIMEOUT_MS: int(1).default(10000),
    SOAP_MAX_RESPONSE_BYTES: int(1).default(2 * 1024 * 1024),
    SOAP_MAX_RESULTS: int(1).default(50),
    SOAP_TLS_CA_FILE: text.optional(),
    SOAP_TLS_CERT_FILE: text.optional(),
    SOAP_TLS_KEY_FILE: text.optional(),
    SOAP_FEATURE_ADDRESS_LINE1: bool.default(false),
    SOAP_FEATURE_CITY: bool.default(false),
    SOAP_FEATURE_POSTAL_CODE: bool.default(false),

    SOAP_HEADER_LANGUAGE_CODE: text,
    SOAP_HEADER_COUNTRY_CODE: text,
    SOAP_HEADER_CHANNEL: text,
    SOAP_HEADER_SUB_CHANNEL: text,
    SOAP_HEADER_ENVIRONMENT: text,
    SOAP_HEADER_SERVICE_USER: text,
    SOAP_HEADER_SEQUENCE: int(1).default(1),
    SOAP_SERVICE_CREDENTIAL: text.optional(),

    SOAP_BREAKER_FAILURE_THRESHOLD: int(1).default(5),
    SOAP_BREAKER_OPEN_MS: int(1).default(30000),

    RATE_LIMIT_SEARCH_PER_MINUTE: int(1).default(30),
    RATE_LIMIT_REVEAL_PER_MINUTE: int(1).default(10),

    REVEAL_TTL_MINUTES: int(1).default(10),

    UI_SCORE_BAND_HIGH: int(0, 100).default(90),
    UI_SCORE_BAND_MEDIUM: int(0, 100).default(70),
    UI_MEMBER_TYPES: memberTypes.default([]),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    AUDIT_LOG_PATH: text.default('logs/audit.jsonl'),

    TELEMETRY_EXPORTER: z.enum(['none', 'console', 'otlp']).default('none'),
    OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.transform((u) => u.href).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.UI_SCORE_BAND_HIGH <= e.UI_SCORE_BAND_MEDIUM) {
      ctx.addIssue({ code: 'custom', path: ['UI_SCORE_BAND_HIGH'], message: 'high <= medium' });
      ctx.addIssue({ code: 'custom', path: ['UI_SCORE_BAND_MEDIUM'], message: 'high <= medium' });
    }
  });

type Env = z.output<typeof envSchema>;

const ENV_KEYS = Object.keys(envSchema.shape) as (keyof typeof envSchema.shape)[];

/** Every configuration key the loader reads (kept in sync with `.env.example` by a test). */
export const CONFIG_KEYS: readonly string[] = ENV_KEYS;

/**
 * Parse the environment into `AppConfig`.
 * @throws StartupError naming missing/invalid keys (never values).
 */
export function loadConfig(env: NodeJS.ProcessEnv, secrets: SecretProvider): AppConfig {
  const secretKeys: readonly string[] = SECRET_KEYS;
  const raw: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    const value = secretKeys.includes(key) ? secrets.get(key) : env[key];
    raw[key] = value === undefined || value.trim() === '' ? undefined : value;
  }

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const missing = new Set<string>();
    const invalid = new Set<string>();
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '');
      (raw[key] === undefined ? missing : invalid).add(key);
    }
    throw configError([...missing].sort(), [...invalid].sort());
  }
  return toAppConfig(result.data);
}

function configError(missing: string[], invalid: string[]): StartupError {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (invalid.length > 0) parts.push(`invalid: ${invalid.join(', ')}`);
  return new StartupError(`Invalid configuration (${parts.join('; ')})`, { missing, invalid });
}

function toAppConfig(e: Env): AppConfig {
  const tls = {
    ...(e.SOAP_TLS_CA_FILE !== undefined && { caFile: e.SOAP_TLS_CA_FILE }),
    ...(e.SOAP_TLS_CERT_FILE !== undefined && { certFile: e.SOAP_TLS_CERT_FILE }),
    ...(e.SOAP_TLS_KEY_FILE !== undefined && { keyFile: e.SOAP_TLS_KEY_FILE }),
  };

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    trustProxy: e.TRUST_PROXY,
    auth: {
      mode: e.AUTH_MODE,
      ...(e.AUTH_MODE === 'dev' && {
        dev: {
          userId: e.DEV_AUTH_USER_ID,
          displayName: e.DEV_AUTH_DISPLAY_NAME,
          roles: e.DEV_AUTH_ROLES,
        },
      }),
    },
    session: {
      // Plain-HTTP localhost cannot set __Host- cookies; task 8.2 enforces the attributes.
      cookieName:
        e.SESSION_COOKIE_NAME ??
        (e.NODE_ENV === 'development' ? 'gs_session' : '__Host-Http-gs_session'),
      ttlMinutes: e.SESSION_TTL_MINUTES,
      absoluteHours: e.SESSION_ABSOLUTE_HOURS,
      secret: e.SESSION_SECRET,
    },
    soap: {
      endpoint: e.SOAP_ENDPOINT,
      soapAction: e.SOAP_ACTION,
      connectTimeoutMs: e.SOAP_CONNECT_TIMEOUT_MS,
      responseTimeoutMs: e.SOAP_RESPONSE_TIMEOUT_MS,
      maxResponseBytes: e.SOAP_MAX_RESPONSE_BYTES,
      maxResults: e.SOAP_MAX_RESULTS,
      ...(Object.keys(tls).length > 0 && { tls }),
      features: {
        addressLine1: e.SOAP_FEATURE_ADDRESS_LINE1,
        city: e.SOAP_FEATURE_CITY,
        postalCode: e.SOAP_FEATURE_POSTAL_CODE,
      },
      header: {
        languageCode: e.SOAP_HEADER_LANGUAGE_CODE,
        countryCode: e.SOAP_HEADER_COUNTRY_CODE,
        channel: e.SOAP_HEADER_CHANNEL,
        subChannel: e.SOAP_HEADER_SUB_CHANNEL,
        environment: e.SOAP_HEADER_ENVIRONMENT,
        serviceUser: e.SOAP_HEADER_SERVICE_USER,
        sequence: e.SOAP_HEADER_SEQUENCE,
        ...(e.SOAP_SERVICE_CREDENTIAL !== undefined && { credential: e.SOAP_SERVICE_CREDENTIAL }),
      },
      breaker: {
        failureThreshold: e.SOAP_BREAKER_FAILURE_THRESHOLD,
        openMs: e.SOAP_BREAKER_OPEN_MS,
      },
    },
    rateLimit: {
      searchPerMinute: e.RATE_LIMIT_SEARCH_PER_MINUTE,
      revealPerMinute: e.RATE_LIMIT_REVEAL_PER_MINUTE,
    },
    reveal: { ttlMinutes: e.REVEAL_TTL_MINUTES },
    ui: {
      scoreBands: { high: e.UI_SCORE_BAND_HIGH, medium: e.UI_SCORE_BAND_MEDIUM },
      memberTypes: e.UI_MEMBER_TYPES,
    },
    log: { level: e.LOG_LEVEL, auditLogPath: e.AUDIT_LOG_PATH },
    telemetry: {
      exporter: e.TELEMETRY_EXPORTER,
      ...(e.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined && {
        otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      }),
    },
  };
}
