// Auth factory, DevAuthProvider and dev personas (task 8.1, Req 20.2-20.5).
import { ROLES } from '@ihg-guest-search/shared';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DevAuthProvider, createAuthProvider } from '../../../src/auth/authProvider.js';
import {
  DEFAULT_DEV_PERSONA,
  DEV_PERSONAS,
  DEV_PERSONA_IDS,
} from '../../../src/auth/devPersonas.js';
import type { AppConfig } from '../../../src/config.js';
import { StartupError } from '../../../src/errors.js';

type AuthCfg = Pick<AppConfig, 'auth' | 'nodeEnv'>;

const jane = { persona: 'jane.doe' as const, ...DEV_PERSONAS['jane.doe'], roles: [ROLES.READ] };
const req = {} as FastifyRequest;

function startupError(fn: () => unknown): StartupError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StartupError);
    return e as StartupError;
  }
  throw new Error('expected StartupError');
}

describe('createAuthProvider', () => {
  it.each(['development', 'test'] as const)('returns DevAuthProvider in %s', async (nodeEnv) => {
    const provider = createAuthProvider({ nodeEnv, auth: { mode: 'dev', dev: jane } });
    expect(provider).toBeInstanceOf(DevAuthProvider);
    expect(provider.mode).toBe('dev');
    await expect(provider.authenticate(req)).resolves.toEqual({
      id: 'dev-jane.doe',
      displayName: 'Jane Doe (Customer Care)',
      roles: [ROLES.READ],
    });
  });

  it('refuses dev auth when NODE_ENV=production (Req 20.4)', () => {
    const err = startupError(() =>
      createAuthProvider({ nodeEnv: 'production', auth: { mode: 'dev', dev: jane } }),
    );
    expect(err.message).toContain('NODE_ENV=production');
    expect(err.invalidKeys).toEqual(['AUTH_MODE']);
    expect(err.message).not.toContain(jane.userId);
  });

  it.each(['development', 'production'] as const)(
    'refuses oidc in %s: not implemented (Req 20.5)',
    (nodeEnv) => {
      const err = startupError(() => createAuthProvider({ nodeEnv, auth: { mode: 'oidc' } }));
      expect(err.message).toBe('OIDC provider not implemented');
    },
  );

  it('refuses dev mode without a configured identity', () => {
    const cfg: AuthCfg = { nodeEnv: 'development', auth: { mode: 'dev' } };
    expect(startupError(() => createAuthProvider(cfg)).missingKeys).toEqual(['DEV_AUTH_PERSONA']);
  });
});

describe('DevAuthProvider', () => {
  it('returns a frozen principal that callers cannot escalate', async () => {
    const roles: string[] = [ROLES.READ];
    const provider = new DevAuthProvider({ ...jane, roles });
    roles.push(ROLES.REVEAL); // mutating the source after construction has no effect
    const p = await provider.authenticate();
    expect(p.roles).toEqual([ROLES.READ]);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.roles)).toBe(true);
  });
});

describe('DEV_PERSONAS', () => {
  it('offers the three role combinations, defaulting to jane.doe', () => {
    expect(DEFAULT_DEV_PERSONA).toBe('jane.doe');
    expect(DEV_PERSONA_IDS).toEqual(['jane.doe', 'read.only', 'no.access']);
    expect(DEV_PERSONAS['jane.doe'].roles).toEqual([ROLES.READ, ROLES.REVEAL]);
    expect(DEV_PERSONAS['read.only'].roles).toEqual([ROLES.READ]);
    expect(DEV_PERSONAS['no.access'].roles).toEqual([]);
  });

  it('is frozen and uses only synthetic dev- IDs and known roles', () => {
    const known: readonly string[] = Object.values(ROLES);
    expect(Object.isFrozen(DEV_PERSONAS)).toBe(true);
    for (const id of DEV_PERSONA_IDS) {
      const p = DEV_PERSONAS[id];
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.roles)).toBe(true);
      // Synthetic: dev- prefix, no DOMAIN\user form like real directory accounts.
      expect(p.userId).toBe(`dev-${id}`);
      expect(p.userId).not.toContain('\\');
      for (const role of p.roles) expect(known).toContain(role);
    }
  });
});
