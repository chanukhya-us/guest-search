// AppShell is the accessible page skeleton and startup orchestrator (design.md
// "apps/web — structure": <Header/>, <main id="main">, skip link, StatusRegion, title
// manager).
//
// Startup (Req 20.8, 3.4): config and me load once via React Query. While either is
// loading the shell shows a busy state; if me comes back UNAUTHENTICATED (401) it shows
// a sign-in banner. Otherwise it renders the header (name, role, DEV AUTH badge) and the
// main content. Sign out (Req 20.11, 21.8, 14.13) calls the logout API, clears the query
// cache and resets to the signed-out view.
//
// The page <h1>, form and results mount in later tasks; task 12.2 provides the stable
// shell, the idle "Search" title, the "/" shortcut and the always-mounted StatusRegion.
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { MeResponse, UiConfig } from '@ihg-guest-search/shared';

import type { GuestSummary } from '@ihg-guest-search/shared';
import { useCallback, useState, type ReactNode } from 'react';

import { ApiError } from '../api/client.js';
import { KeyboardIcon, ShieldIcon, UsersIcon } from '../components/icons.js';
import { logout } from '../api/session.js';
import { useShortcut } from '../a11y/useShortcut.js';
import { GuestDetailsDrawer } from '../features/results/GuestDetailsDrawer.js';
import { ResultsPanel } from '../features/results/ResultsPanel.js';
import { useReveal } from '../features/results/useReveal.js';
import { SearchForm } from '../features/search/SearchForm.js';
import { useGuestSearch } from '../features/search/useGuestSearch.js';
import { Header } from './Header.js';
import { hasRevealRole, useMe } from './useMe.js';
import { useTitle } from './useTitle.js';
import { useUiConfig } from './useUiConfig.js';

export function AppShell() {
  const queryClient = useQueryClient();
  const me = useMe();
  const config = useUiConfig();

  // Shell-level title baseline: "Search" while loading / signed out. Once the search
  // controller mounts (ShellReady), it owns the title and reflects the search state
  // (Searching / {n} results / No results / Error), returning to "Search" on idle/clear.
  useTitle('Search');
  useShortcut();

  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      // Drop every cached query (results, me, config) so no data outlives the session
      // (Req 21.8, 14.13). The me/config queries refetch on the next render, returning
      // the app to its signed-out / fresh-login view.
      queryClient.clear();
    },
  });

  const unauthenticated = me.error instanceof ApiError && me.error.code === 'UNAUTHENTICATED';
  const isLoading = me.isLoading || config.isLoading;

  return (
    <>
      {/* Skip link: first focusable element, jumps to the main landmark (Req 24.3). */}
      <a
        href="#main"
        className="sr-only rounded-control bg-navy px-4 py-2 text-surface focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-20"
      >
        Skip to main content
      </a>

      <Header me={me.data} signingOut={signOut.isPending} onSignOut={() => signOut.mutate()} />

      {/*
        Fluid layout: main fills the viewport width (minus gutters) so the 14-column results
        table uses all available space on wide screens and only scrolls horizontally, inside
        its own region, when the window is genuinely too narrow (Req 15.8, 24.8). min-w-0 lets
        flex/grid children shrink instead of forcing page-level overflow.
      */}
      <main id="main" className="w-full min-w-0 px-4 py-6 sm:px-6 lg:px-8">
        {isLoading ? (
          <ShellLoading />
        ) : unauthenticated ? (
          <SignInBanner />
        ) : (
          <ShellReady me={me.data} config={config.data} />
        )}
      </main>
    </>
  );
}

/**
 * Navy hero band with the page heading (h1), a short intro and three quick-tip chips.
 * Full-bleed: negative margins cancel main's gutters. The abstract artwork is a decorative
 * CSS background (original self-hosted SVG), so it adds nothing to the accessibility tree.
 * White on navy is ~10:1, and the tip chips carry text plus a decorative icon (Req 24.5).
 */
function Hero({ displayName, canReveal }: { displayName?: string; canReveal: boolean }) {
  return (
    <div className="hero-band -mx-4 -mt-6 px-4 pb-20 pt-10 text-surface sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="animate-rise-in">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-navy-tint">
          IHG Hotels &amp; Resorts · Colleague tools
        </p>
        <h1 className="mt-2 text-[2rem] font-semibold leading-tight">Guest Search</h1>
        <p className="mt-2 max-w-2xl text-base text-surface/90">
          {displayName ? `Welcome, ${displayName}. ` : ''}
          Search for IHG guests by name, contact details, address or loyalty membership.
        </p>
        <ul className="mt-5 flex flex-wrap gap-2 text-sm" aria-label="Quick tips">
          <TipChip icon={<KeyboardIcon size={16} />}>
            Press <kbd className="kbd mx-1">/</kbd> to start typing
          </TipChip>
          <TipChip icon={<ShieldIcon size={16} />}>
            {canReveal
              ? 'Contact details are masked until you reveal them'
              : 'Contact details are masked for privacy'}
          </TipChip>
          <TipChip icon={<UsersIcon size={16} />}>Results ranked by match score</TipChip>
        </ul>
      </div>
    </div>
  );
}

function TipChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-2 rounded-full border border-surface/20 bg-surface/10 px-3 py-1.5 backdrop-blur-sm">
      <span className="text-decorative">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

/** Busy state while config and me load. Announced via aria-busy on a labelled region. */
function ShellLoading() {
  return (
    <div role="status" aria-busy="true" className="flex items-center gap-3 py-12 text-text-2">
      <span
        aria-hidden="true"
        className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-navy"
      />
      Loading Guest Search…
    </div>
  );
}

/**
 * Signed-out / expired session banner (design.md UI mapping: UNAUTHENTICATED → "Sign in
 * again"). Uses role="alert" with text and an icon, never colour alone (Req 24.5, 24.9).
 */
function SignInBanner() {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-card border-l-4 border-error bg-error-wash p-4 text-body"
    >
      <span aria-hidden="true" className="mt-0.5 font-semibold text-error">
        !
      </span>
      <div>
        <h1 className="text-xl font-semibold text-navy">Please sign in again</h1>
        <p className="mt-1 text-text-2">
          Your session has expired. Reload the page or sign in again to continue searching for
          guests.
        </p>
      </div>
    </div>
  );
}

/**
 * Loaded, authenticated view: the page heading, intro, the search form (task 12.3) and
 * the results region driven by the search controller (task 12.4).
 *
 * The controller (useGuestSearch) owns the search mutation, the idle→loading→results|
 * empty|error state machine, request cancellation (Req 18.3), the document title and the
 * polite announcements. It hands:
 *   - `submitting` + `serverErrors` down to SearchForm (loading disable + Req 5.7 mapping);
 *   - `state` + the reveal-role flag down to ResultsPanel (the table boundary for 12.5).
 * `onSearch` now feeds the controller instead of the old no-op seam.
 *
 * If a mid-session search returns UNAUTHENTICATED (expired session), the controller
 * reports it and we show the same sign-in banner as the startup path (Req 20).
 */
function ShellReady({ me, config }: { me?: MeResponse; config?: UiConfig }) {
  const search = useGuestSearch();
  const canReveal = hasRevealRole(me);

  // The in-memory reveal store (task 12.7), shared by the table rows and the drawer.
  // Unmasked values live only here and are discarded on a new search, Clear and sign-out
  // (Req 14.13, 21.7); on sign-out this whole subtree unmounts, resetting the map too.
  const reveal = useReveal();

  // The guest whose details drawer is open (Req 16). null = closed. Opening is driven by
  // the table's "View details"; closing (Esc / Close / backdrop) returns focus to that
  // control automatically via React Aria (Req 16.4).
  const [selected, setSelected] = useState<GuestSummary | null>(null);

  const handleSelect = useCallback((summary: GuestSummary): void => {
    setSelected(summary);
  }, []);
  const closeDrawer = useCallback((): void => setSelected(null), []);

  // Wrap the controller callbacks so a new search, Try again and Clear all discard every
  // revealed value and close any open drawer before the request runs (Req 14.13). The
  // underlying controller still owns the request lifecycle and the state machine.
  const onSearch = useCallback(
    (criteria: Parameters<typeof search.submit>[0]) => {
      reveal.clear();
      setSelected(null);
      search.submit(criteria);
    },
    [reveal, search],
  );
  const onRetry = useCallback(() => {
    reveal.clear();
    setSelected(null);
    search.retry();
  }, [reveal, search]);
  const onClear = useCallback(() => {
    reveal.clear();
    setSelected(null);
    search.clear();
  }, [reveal, search]);

  if (search.unauthenticated) {
    return <SignInBanner />;
  }

  return (
    <>
      <Hero displayName={me?.displayName} canReveal={canReveal} />
      {config && (
        // The search card overlaps the bottom of the navy hero, like the booking panel
        // that sits on the navy band on ihg.com.
        <div className="relative -mt-14 animate-rise-in">
          <SearchForm
            config={config}
            onSearch={onSearch}
            submitting={search.submitting}
            serverErrors={search.serverErrors}
            onClear={onClear}
          />
        </div>
      )}
      <ResultsPanel
        state={search.state}
        canReveal={canReveal}
        reveal={reveal}
        scoreBands={config?.scoreBands ?? { high: 90, medium: 70 }}
        onSelect={handleSelect}
        onRetry={onRetry}
      />
      <GuestDetailsDrawer
        summary={selected}
        canReveal={canReveal}
        reveal={reveal}
        onClose={closeDrawer}
      />
    </>
  );
}
