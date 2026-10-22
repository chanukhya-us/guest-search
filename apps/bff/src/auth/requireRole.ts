/**
 * Route-level authorization (design.md "apps/bff — auth", Req 20.7, 14.8).
 *
 * The preHandler throws `AppError`; the error handler (task 8.5) maps the code to its
 * `ERROR_CATALOG` status and message, so the response never reveals which role was missing.
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from '../errors.js';
import type { Principal } from './authProvider.js';

export function hasRole(principal: Principal | null | undefined, role: string): boolean {
  return principal?.roles.includes(role) ?? false;
}

export function requireRole(role: string): preHandlerAsyncHookHandler {
  return async function requireRoleHandler(request: FastifyRequest): Promise<void> {
    // Defense in depth: the auth plugin already rejects unauthenticated /api/* calls.
    if (request.principal === null || request.principal === undefined) {
      throw new AppError('UNAUTHENTICATED', 'No principal on request');
    }
    if (!hasRole(request.principal, role)) {
      throw new AppError('FORBIDDEN', 'Principal lacks the required role');
    }
  };
}
