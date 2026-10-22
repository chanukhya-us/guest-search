// SPA static serving + fallback (task 8.6; design.md plugin 10, Req 21.5).
//
// `buildApp` serves the built SPA only when a `dist` directory with an `index.html` is present
// (or an explicit `serveStaticDir` is injected). These tests point it at a temp dir with a
// marker `index.html` and assert the SPA fallback never shadows `/api` or `/health`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROLES } from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import type { AuthProvider, Principal } from '../../../src/auth/authProvider.js';
import type { AppConfig } from '../../../src/config.js';
import type {
  GuestSearchGateway,
  GuestSearchOutcome,
} from '../../../src/ports/GuestSearchGateway.js';

const SPA_MARKER = '<!doctype html><title>IHG Guest Search SPA</title>';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const JANE: Principal = {
  id: 'dev-jane.doe',
  displayName: 'Jane Doe',
  roles: [ROLES.READ, ROLES.REVEAL],
};

const stubGateway: GuestSearchGateway = {
  search: (): Promise<GuestSearchOutcome> => Promise.resolve({ results: [], limit: 50 }),
};

function provider(principal: Principal | null): AuthProvider {
  return { mode: 'dev', authenticate: (): Promise<Principal | null> => Promise.resolve(principal) };
}

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    trustProxy: false,
    auth: { mode: 'dev' },
    session: { cookieName: 'gs_session', ttlMinutes: 30, absoluteHours: 8, secret: SESSION_SECRET },
    soap: {
      endpoint: new URL('http://soap.invalid:8080/InitiateService'),
      soapAction: 'searchGuest',
      channelId: 'WEBWB',
      connectTimeoutMs: 3000,
      responseTimeoutMs: 10000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxResults: 50,
      features: { addressLine1: false, city: false, postalCode: false },
      header: {
        languageCode: 'en',
        countryCode: 'US',
        channel: 'test',
        subChannels: ['sub'],
        environment: 'test',
        serviceUser: 'svc',
        sequence: 1,
      },
      breaker: { failureThreshold: 5, openMs: 30000 },
    },
    rateLimit: { searchPerMinute: 30, revealPerMinute: 10 },
    reveal: { ttlMinutes: 10 },
    ui: { scoreBands: { high: 90, medium: 70 }, memberTypes: [] },
    log: { level: 'silent', auditLogPath: 'logs/audit.jsonl' },
    telemetry: { exporter: 'none' },
  };
}

let dir: string;
let app: FastifyInstance | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ihg-spa-'));
  writeFileSync(join(dir, 'index.html'), SPA_MARKER, 'utf8');
  writeFileSync(join(dir, 'app.js'), 'console.log("bundle");', 'utf8');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function build(): Promise<FastifyInstance> {
  return buildApp(makeConfig(), {
    gateway: stubGateway,
    authProvider: provider(JANE),
    readinessConnect: () => Promise.resolve(true),
    serveStaticDir: dir,
  });
}

describe('SPA serving', () => {
  it('serves index.html at the root', async () => {
    app = await build();
    const res = await app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('IHG Guest Search SPA');
  });

  it('serves a real static asset directly', async () => {
    app = await build();
    const res = await app.inject('/app.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('bundle');
  });

  it('falls back to index.html for a client-side deep link', async () => {
    app = await build();
    const res = await app.inject('/results/900000001');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('IHG Guest Search SPA');
  });

  it('never serves index.html for an unknown /api route (JSON 404)', async () => {
    app = await build();
    const res = await app.inject('/api/v1/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('IHG Guest Search SPA');
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('never serves index.html for an unknown /health route (JSON 404)', async () => {
    app = await build();
    const res = await app.inject('/health/unknown');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('IHG Guest Search SPA');
  });

  it('still serves the real API when the SPA is mounted', async () => {
    app = await build();
    const res = await app.inject('/api/v1/config');
    expect(res.statusCode).toBe(200);
    expect(res.json().authMode).toBe('dev');
  });
});
