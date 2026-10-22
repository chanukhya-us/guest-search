/**
 * Pluggable authentication (design.md "apps/bff — auth", Req 20.1-20.5).
 *
 * The BFF obtains the Principal for every API request through `AuthProvider` (Req 20.1).
 * `createAuthProvider` selects the provider from `AUTH_MODE` (Req 20.2) and refuses to
 * start when the selection is unsafe or not implemented (Req 20.4, 20.5).
 */
import type { AuthMode } from '@ihg-guest-search/shared';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { StartupError } from '../errors.js';
import type { DevIdentity } from './devPersonas.js';

export interface Principal {
  readonly id: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface AuthProvider {
  readonly mode: AuthMode;
  /** Resolves the caller, or `null` when unauthenticated (the auth plugin then sends 401). */
  authenticate(req: FastifyRequest): Promise<Principal | null>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth plugin on every `/api/*` request (task 8.5). */
    principal: Principal | null;
  }
}

/**
 * Local placeholder: every request is the configured dev identity (Req 20.3).
 * Not a security control. Never constructed in production (see `createAuthProvider`).
 */
export class DevAuthProvider implements AuthProvider {
  readonly mode = 'dev' as const;
  private readonly principal: Principal;

  constructor(identity: DevIdentity) {
    this.principal = Object.freeze({
      id: identity.userId,
      displayName: identity.displayName,
      roles: Object.freeze([...identity.roles]),
    });
  }

  authenticate(): Promise<Principal> {
    return Promise.resolve(this.principal);
  }
}

/**
 * @throws StartupError for dev auth in production (Req 20.4) and for `oidc` until an
 *   OIDC provider is implemented (Req 20.5). Messages name keys only, never values.
 */
export function createAuthProvider(cfg: Pick<AppConfig, 'auth' | 'nodeEnv'>): AuthProvider {
  if (cfg.auth.mode === 'oidc') {
    throw new StartupError('OIDC provider not implemented');
  }
  if (cfg.nodeEnv === 'production') {
    throw new StartupError(
      'AUTH_MODE=dev is not allowed when NODE_ENV=production; configure a real identity provider',
      { invalid: ['AUTH_MODE'] },
    );
  }
  if (cfg.auth.dev === undefined) {
    throw new StartupError('Dev auth identity is not configured', {
      missing: ['DEV_AUTH_PERSONA'],
    });
  }
  return new DevAuthProvider(cfg.auth.dev);
}
