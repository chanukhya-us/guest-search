/**
 * Synthetic dev personas for `DevAuthProvider` (design.md "apps/bff — auth", Req 20.3).
 *
 * Local-only test identities, selected at startup with `DEV_AUTH_PERSONA`. They let a
 * developer try each role combination: full access, read only, and no access (403).
 * IDs and names are synthetic placeholders; never add real names or employee IDs.
 * They are used only in dev mode, which refuses to start in production (Req 20.4).
 */
import { ROLES } from '@ihg-guest-search/shared';

export interface DevIdentity {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export const DEV_PERSONAS = deepFreeze({
  'jane.doe': {
    userId: 'dev-jane.doe',
    displayName: 'Jane Doe (Customer Care)',
    roles: [ROLES.READ, ROLES.REVEAL],
  },
  'read.only': {
    userId: 'dev-read.only',
    displayName: 'Riley Reader (Read only)',
    roles: [ROLES.READ],
  },
  'no.access': {
    userId: 'dev-no.access',
    displayName: 'Nora NoAccess',
    roles: [],
  },
} satisfies Record<string, DevIdentity>);

export type DevPersonaId = keyof typeof DEV_PERSONAS;

/** Persona used when `DEV_AUTH_PERSONA` is unset. */
export const DEFAULT_DEV_PERSONA: DevPersonaId = 'jane.doe';

export const DEV_PERSONA_IDS = Object.keys(DEV_PERSONAS) as [DevPersonaId, ...DevPersonaId[]];

function deepFreeze<T extends Record<string, DevIdentity>>(personas: T): Readonly<T> {
  for (const p of Object.values(personas)) Object.freeze(Object.freeze(p).roles);
  return Object.freeze(personas);
}
