// Server entry point (task 8.6): startServer loads config, builds the app and listens; a
// StartupError from config/provider construction propagates for the entry's fatal handler.
import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from '../../src/index.js';
import { StartupError } from '../../src/errors.js';

const SECRET = 'test-session-secret-0123456789abcdef';

/** A full, valid environment. A high, unlikely-used port keeps the listen test isolated. */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '39517',
  SOAP_ENDPOINT: 'http://localhost:8080/InitiateService',
  SOAP_HEADER_LANGUAGE_CODE: 'en',
  SOAP_HEADER_COUNTRY_CODE: 'US',
  SOAP_HEADER_CHANNEL: 'test-channel',
  SOAP_HEADER_SUB_CHANNEL: 'test-subchannel',
  SOAP_HEADER_ENVIRONMENT: 'test',
  SOAP_HEADER_SERVICE_USER: 'test-service-user',
  SESSION_SECRET: SECRET,
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('startServer', () => {
  it('loads config, builds the app and listens on the configured port', async () => {
    const server = await startServer({ ...BASE_ENV });
    close = server.close;
    expect(server.port).toBe(39517);
  });

  it('propagates a StartupError for an unimplemented OIDC auth mode', async () => {
    await expect(startServer({ ...BASE_ENV, AUTH_MODE: 'oidc' })).rejects.toBeInstanceOf(
      StartupError,
    );
  });

  it('propagates a StartupError for dev auth in production', async () => {
    await expect(
      startServer({ ...BASE_ENV, NODE_ENV: 'production', AUTH_MODE: 'dev' }),
    ).rejects.toBeInstanceOf(StartupError);
  });

  it('propagates a StartupError naming a missing required config key', async () => {
    const withoutSecret = { ...BASE_ENV };
    delete withoutSecret.SESSION_SECRET;
    await expect(startServer(withoutSecret)).rejects.toMatchObject({
      name: 'StartupError',
      missingKeys: expect.arrayContaining(['SESSION_SECRET']),
    });
  });
});
