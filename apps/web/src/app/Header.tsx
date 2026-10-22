// Two-tier IHG header (Req 23.5): a 40px navy utility bar above a 64px white brand bar.
//
// Utility bar (Req 20.9): a DEV AUTH badge while AUTH_MODE is dev, the colleague's
// display name and role, and a Sign out control. Brand bar: the BrandLogo and the
// "Guest Search" product title. Both bars are sticky so scroll-padding-top (theme.css)
// keeps a focused element clear of them (Req 24.7).
//
// The header is presentational: the shell passes the resolved principal (or undefined
// while loading / unauthenticated), the auth mode and a sign-out callback.
import type { MeResponse } from '@ihg-guest-search/shared';

import { BrandLogo } from './BrandLogo.js';

interface HeaderProps {
  me: MeResponse | undefined;
  /** Disable Sign out while a logout request is in flight. */
  signingOut?: boolean;
  onSignOut: () => void;
}

/** Human-friendly role label from the technical role strings (first wins). */
function roleLabel(roles: string[] | undefined): string | undefined {
  if (!roles || roles.length === 0) return undefined;
  if (roles.includes('GuestSearch.RevealPII')) return 'Reveal access';
  if (roles.includes('GuestSearch.Read')) return 'Search access';
  return roles[0];
}

export function Header({ me, signingOut = false, onSignOut }: HeaderProps) {
  const isDevAuth = me?.authMode === 'dev';
  const role = roleLabel(me?.roles);

  return (
    <header className="sticky top-0 z-10">
      {/* Utility bar - 40px, navy. */}
      <div className="flex h-10 items-center justify-end gap-4 bg-navy-deep px-4 text-sm text-surface sm:px-6 lg:px-8">
        {isDevAuth && (
          <span className="rounded-chip bg-primary px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-surface">
            Dev auth
          </span>
        )}
        {me && (
          <>
            <span className="font-medium">{me.displayName}</span>
            {role && <span className="text-navy-tint">{role}</span>}
            <button
              type="button"
              onClick={onSignOut}
              disabled={signingOut}
              className="rounded-control px-2 py-1 font-medium underline underline-offset-2 hover:bg-navy-tint hover:text-navy disabled:opacity-60"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        )}
      </div>

      {/* Brand bar - 64px, white, with the logo and product title. */}
      <div className="relative flex h-16 items-center gap-3 bg-surface px-4 shadow-header sm:px-6 lg:px-8">
        <BrandLogo />
        <span aria-hidden="true" className="h-6 w-px bg-border" />
        <span className="text-xl font-semibold text-navy">Guest Search</span>
        {/* Decorative brand accent line under the brand bar. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-primary via-decorative to-transparent"
        />
      </div>
    </header>
  );
}
