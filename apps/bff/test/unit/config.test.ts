// Unit tests for the config loader and secret provider (task 3.2, Req 2.6, 8.3-8.6).
// Task 3.4 adds further config coverage.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  EnvSecretProvider,
  MIN_SESSION_SECRET_LENGTH,
  loadConfig,
  type SecretProvider,
} from '../../src/config.js';
import { StartupError } from '../../src/errors.js';

const SECRET = 'test-session-secret-0123456789abcdef';

/** Required keys only; everything else falls back to its default. */
const REQUIRED: Record<string, string> = {
  SOAP_ENDPOINT: 'http://localhost:8080/GuestSearchService',
  SOAP_ACTION: 'test-action',
  SOAP_HEADER_LANGUAGE_CODE: 'en',
  SOAP_HEADER_COUNTRY_CODE: 'US',
  SOAP_HEADER_CHANNEL: 'test-channel',
  SOAP_HEADER_SUB_CHANNEL: 'test-subchannel',
  SOAP_HEADER_ENVIRONMENT: 'test',
  SOAP_HEADER_SERVICE_USER: 'test-service-user',
  SESSION_SECRET: SECRET,
};

/** Secrets and env both come from the same map unless a test overrides one. */
function load(env: Record<string, string | undefined>, secrets?: SecretProvider) {
  return loadConfig(env, secrets ?? new EnvSecretProvider(env));
}

function startupError(fn: () => unknown): StartupError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StartupError);
    return e as StartupError;
  }
  throw new Error('expected StartupError');
}

/** Minimal dotenv reader for `.env.example` (KEY=VALUE lines, # comments). */
function readEnvExample(): Record<string, string> {
  const text = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined) out[m[1]] = m[2] ?? '';
  }
  return out;
}

describe('loadConfig defaults', () => {
  it('applies every documented default when only required keys are set', () => {
    const c = load(REQUIRED);
    expect(c.nodeEnv).toBe('development');
    expect(c.port).toBe(3000);
    expect(c.trustProxy).toBe(false);
    expect(c.auth).toEqual({
      mode: 'dev',
      dev: {
        userId: 'dev-user-001',
        displayName: 'Dev Colleague',
        roles: ['GuestSearch.Read', 'GuestSearch.RevealPII'],
      },
    });
    expect(c.session).toEqual({
      cookieName: 'gs_session',
      ttlMinutes: 30,
      absoluteHours: 8,
      secret: SECRET,
    });
    expect(c.soap.endpoint).toBeInstanceOf(URL);
    expect(c.soap.endpoint.href).toBe(REQUIRED.SOAP_ENDPOINT);
    expect(c.soap).toMatchObject({
      soapAction: 'test-action',
      connectTimeoutMs: 3000,
      responseTimeoutMs: 10000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxResults: 50,
      features: { addressLine1: false, city: false, postalCode: false },
      header: {
        languageCode: 'en',
        countryCode: 'US',
        channel: 'test-channel',
        subChannel: 'test-subchannel',
        environment: 'test',
        serviceUser: 'test-service-user',
        sequence: 1,
      },
      breaker: { failureThreshold: 5, openMs: 30000 },
    });
    expect(c.soap.tls).toBeUndefined();
    expect(c.soap.header.credential).toBeUndefined();
    expect(c.rateLimit).toEqual({ searchPerMinute: 30, revealPerMinute: 10 });
    expect(c.reveal).toEqual({ ttlMinutes: 10 });
    expect(c.ui).toEqual({ scoreBands: { high: 90, medium: 70 }, memberTypes: [] });
    expect(c.log).toEqual({ level: 'info', auditLogPath: 'logs/audit.jsonl' });
    expect(c.telemetry).toEqual({ exporter: 'none' });
  });

  it('treats empty and whitespace-only values as unset', () => {
    const c = load({ ...REQUIRED, PORT: '', SOAP_MAX_RESULTS: '   ', SESSION_COOKIE_NAME: '' });
    expect(c.port).toBe(3000);
    expect(c.soap.maxResults).toBe(50);
  });

  it('uses the __Host- cookie name outside development', () => {
    expect(load({ ...REQUIRED, NODE_ENV: 'production' }).session.cookieName).toBe(
      '__Host-Http-gs_session',
    );
  });

  it('parses overrides, optional TLS paths, oidc mode and member types', () => {
    const c = load({
      ...REQUIRED,
      NODE_ENV: 'test',
      AUTH_MODE: 'oidc',
      TRUST_PROXY: 'true',
      SOAP_FEATURE_CITY: 'true',
      SOAP_TLS_CA_FILE: 'certs/ca.pem',
      SOAP_SERVICE_CREDENTIAL: 'test-credential',
      SOAP_HEADER_SEQUENCE: '3',
      UI_MEMBER_TYPES: '[{"code":"A","label":"Alpha"},{"code":"B","label":"Beta"}]',
      TELEMETRY_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    });
    expect(c.auth).toEqual({ mode: 'oidc' });
    expect(c.trustProxy).toBe(true);
    expect(c.soap.features.city).toBe(true);
    expect(c.soap.tls).toEqual({ caFile: 'certs/ca.pem' });
    expect(c.soap.header.credential).toBe('test-credential');
    expect(c.soap.header.sequence).toBe(3);
    expect(c.ui.memberTypes).toEqual([
      { code: 'A', label: 'Alpha' },
      { code: 'B', label: 'Beta' },
    ]);
    expect(c.telemetry).toEqual({ exporter: 'otlp', otlpEndpoint: 'http://localhost:4318/' });
  });

  it('loads .env.example, whose keys match the loader and whose values match the defaults', () => {
    const example = readEnvExample();
    expect(Object.keys(example).sort()).toEqual([...CONFIG_KEYS].sort());

    const fromExample = load(example);
    const fromDefaults = load({
      ...Object.fromEntries(Object.keys(REQUIRED).map((k) => [k, example[k]])),
      UI_MEMBER_TYPES: example.UI_MEMBER_TYPES,
    });
    expect(fromExample).toEqual(fromDefaults);
  });
});

describe('loadConfig failures', () => {
  it('names every missing required key', () => {
    const err = startupError(() => load({}));
    expect([...err.missingKeys]).toEqual(Object.keys(REQUIRED).sort());
    expect(err.invalidKeys).toEqual([]);
    for (const key of Object.keys(REQUIRED)) expect(err.message).toContain(key);
  });

  it.each(Object.keys(REQUIRED))(
    'names a single missing %s without printing any configured value (Req 8.5)',
    (key) => {
      const rest = { ...REQUIRED };
      delete rest[key];
      const err = startupError(() => load(rest));
      expect([...err.missingKeys]).toEqual([key]);
      expect(err.message).toBe(`Invalid configuration (missing: ${key})`);
      // Short codes such as 'US' occur inside key names, so check only distinctive values.
      for (const value of Object.values(rest).filter((v) => v.length >= 8)) {
        expect(err.message).not.toContain(value);
        expect(String(err.stack)).not.toContain(value);
      }
    },
  );

  it.each([
    ['SOAP_CONNECT_TIMEOUT_MS', 'abc'],
    ['SOAP_MAX_RESULTS', '0'],
    ['SOAP_MAX_RESULTS', '1.5'],
    ['PORT', '70000'],
    ['TRUST_PROXY', 'yes'],
    ['SOAP_FEATURE_CITY', 'TRUE'],
    ['SOAP_FEATURE_POSTAL_CODE', '1'],
    ['NODE_ENV', 'staging'],
    ['AUTH_MODE', 'saml'],
    ['LOG_LEVEL', 'verbose'],
    ['TELEMETRY_EXPORTER', 'jaeger'],
    ['SOAP_ENDPOINT', 'ftp://example.test/soap'],
    ['SOAP_ENDPOINT', 'not a url'],
    ['SOAP_ACTION', 'action\r\nInjected: 1'],
    ['SESSION_COOKIE_NAME', 'bad name;'],
    ['DEV_AUTH_ROLES', ' , '],
    ['UI_MEMBER_TYPES', '{not json'],
    ['UI_MEMBER_TYPES', '{"code":"A","label":"Alpha"}'],
    ['UI_MEMBER_TYPES', '[{"code":"A"}]'],
    ['UI_MEMBER_TYPES', '[{"code":"A","label":"Alpha","extra":1}]'],
    ['UI_MEMBER_TYPES', '[{"code":"A","label":"x"},{"code":"A","label":"y"}]'],
    ['UI_SCORE_BAND_HIGH', '101'],
  ])('reports %s=%j as invalid', (key, value) => {
    const err = startupError(() => load({ ...REQUIRED, [key]: value }));
    expect(err.invalidKeys).toContain(key);
    expect(err.missingKeys).toEqual([]);
    expect(err.message).toContain(key);
  });

  it('rejects score bands where high is not above medium', () => {
    const err = startupError(() =>
      load({ ...REQUIRED, UI_SCORE_BAND_HIGH: '70', UI_SCORE_BAND_MEDIUM: '70' }),
    );
    expect([...err.invalidKeys]).toEqual(['UI_SCORE_BAND_HIGH', 'UI_SCORE_BAND_MEDIUM']);
  });

  it('reports missing and invalid keys together', () => {
    const rest = { ...REQUIRED };
    delete rest.SOAP_ACTION;
    const err = startupError(() => load({ ...rest, SOAP_RESPONSE_TIMEOUT_MS: '-1' }));
    expect(err.message).toBe(
      'Invalid configuration (missing: SOAP_ACTION; invalid: SOAP_RESPONSE_TIMEOUT_MS)',
    );
  });
});

describe('no value leakage (Req 8.5)', () => {
  it('names a too-short SESSION_SECRET without printing it', () => {
    const shortSecret = 'S3cr3t-value-x9';
    expect(shortSecret.length).toBeLessThan(MIN_SESSION_SECRET_LENGTH);
    const err = startupError(() => load({ ...REQUIRED, SESSION_SECRET: shortSecret }));
    expect(err.invalidKeys).toEqual(['SESSION_SECRET']);
    expect(err.message).toContain('SESSION_SECRET');
    expect(err.message).not.toContain(shortSecret);
    expect(JSON.stringify(err)).not.toContain(shortSecret);
    expect(String(err.stack)).not.toContain(shortSecret);
  });

  it('names an invalid SOAP_ENDPOINT without printing it', () => {
    const badUrl = 'gopher://internal-host-zq7.example:70/x';
    const err = startupError(() => load({ ...REQUIRED, SOAP_ENDPOINT: badUrl }));
    expect(err.message).toContain('SOAP_ENDPOINT');
    expect(err.message).not.toContain('internal-host-zq7');
    expect(String(err.stack)).not.toContain('internal-host-zq7');
  });
});

describe('secrets come only from SecretProvider (Req 8.4)', () => {
  it('ignores secret keys present in env when the provider lacks them', () => {
    const err = startupError(() => load(REQUIRED, { get: () => undefined }));
    expect([...err.missingKeys]).toEqual(['SESSION_SECRET', 'SOAP_HEADER_SERVICE_USER']);
  });

  it('takes secret values from the provider, not from env', () => {
    const vault = new Map([
      ['SESSION_SECRET', 'vault-session-secret-abcdefghijklmnopqrstuvwxyz'],
      ['SOAP_HEADER_SERVICE_USER', 'vault-user'],
      ['SOAP_SERVICE_CREDENTIAL', 'vault-credential'],
    ]);
    const c = load(REQUIRED, { get: (k) => vault.get(k) });
    expect(c.session.secret).toBe(vault.get('SESSION_SECRET'));
    expect(c.soap.header.serviceUser).toBe('vault-user');
    expect(c.soap.header.credential).toBe('vault-credential');
  });
});

describe('EnvSecretProvider', () => {
  it('reads keys from the supplied environment', () => {
    const p = new EnvSecretProvider({ SESSION_SECRET: 'x' });
    expect(p.get('SESSION_SECRET')).toBe('x');
    expect(p.get('MISSING')).toBeUndefined();
  });

  it('defaults to process.env', () => {
    const key = 'GS_TEST_SECRET_PROVIDER_KEY';
    process.env[key] = 'from-process';
    try {
      expect(new EnvSecretProvider().get(key)).toBe('from-process');
    } finally {
      delete process.env[key];
    }
  });
});
