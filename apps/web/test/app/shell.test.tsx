// App shell tests (task 12.2). Uses MSW 3 REST handlers (msw/node intercepts fetch in
// jsdom) to drive the real client + React Query + shell together:
//   - loading → loaded: the header shows the mocked user, role and DEV AUTH badge;
//   - UNAUTHENTICATED (401): the sign-in banner renders instead of the content;
//   - Sign out: clicking it calls POST /session/logout and transitions back to loading;
//   - the document title is the idle "Search – Guest Search – IHG" (Req 24.11);
//   - the skip link and main landmark are present (Req 24.3).
//
// MSW 3 renamed onUnhandledRequest to onUnhandledFrame; an unexpected call fails the test.
import type { MeResponse, UiConfig } from '@ihg-guest-search/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { App } from '../../src/App';

const DEV_ME: MeResponse = {
  displayName: 'Dana Example',
  roles: ['GuestSearch.Read', 'GuestSearch.RevealPII'],
  authMode: 'dev',
};

const UI_CONFIG: UiConfig = {
  scoreBands: { high: 90, medium: 70 },
  memberTypes: [{ code: 'PC', label: 'Platinum' }],
  features: { addressLine1: false, city: false, postalCode: false },
  authMode: 'dev',
};

function meHandler(me: MeResponse) {
  return http.get('/api/v1/me', () => HttpResponse.json(me));
}

function configHandler(config: UiConfig) {
  return http.get('/api/v1/config', () => HttpResponse.json(config));
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('AppShell startup', () => {
  it('renders the accessible shell: skip link and main landmark', async () => {
    server.use(meHandler(DEV_ME), configHandler(UI_CONFIG));
    render(<App />);

    expect(screen.getByRole('link', { name: /skip to main content/i })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('sets the idle document title (Req 24.11)', async () => {
    server.use(meHandler(DEV_ME), configHandler(UI_CONFIG));
    render(<App />);
    await waitFor(() => expect(document.title).toBe('Search – Guest Search – IHG'));
  });

  it('shows a busy state while me and config load, then the loaded view', async () => {
    let resolveMe: (r: Response) => void = () => {};
    server.use(
      http.get('/api/v1/me', () => new Promise<Response>((res) => (resolveMe = res))),
      configHandler(UI_CONFIG),
    );
    render(<App />);

    // Busy region appears first.
    const busy = await screen.findByRole('status', { busy: true });
    expect(busy).toHaveTextContent(/loading guest search/i);

    // Resolve me; the loaded content replaces the busy state.
    resolveMe(HttpResponse.json(DEV_ME));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Guest Search' }),
    ).toBeInTheDocument();
  });

  it('shows the user name, role and DEV AUTH badge in the header', async () => {
    server.use(meHandler(DEV_ME), configHandler(UI_CONFIG));
    render(<App />);

    await screen.findByRole('heading', { level: 1, name: 'Guest Search' });
    const banner = screen.getByRole('banner');
    expect(banner).toHaveTextContent('Dana Example');
    expect(banner).toHaveTextContent(/dev auth/i);
    expect(banner).toHaveTextContent(/reveal access/i);
  });

  it('shows the sign-in banner when me is UNAUTHENTICATED (401)', async () => {
    server.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json(
          {
            requestId: 'r1',
            success: false,
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Your session has expired. Please sign in again.',
            },
          },
          { status: 401 },
        ),
      ),
      configHandler(UI_CONFIG),
    );
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/please sign in again/i);
    // The signed-in header controls are absent.
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });
});

describe('AppShell sign out', () => {
  it('calls logout and transitions back to the loading state', async () => {
    let logoutCalls = 0;
    // me resolves once, then (after queryClient.clear) the refetch hangs so we can
    // observe the loading transition deterministically.
    let meCall = 0;
    server.use(
      http.get('/api/v1/me', () => {
        meCall += 1;
        if (meCall === 1) return HttpResponse.json(DEV_ME);
        return new Promise<Response>(() => {}); // never resolves: stays loading
      }),
      configHandler(UI_CONFIG),
      http.post('/api/v1/session/logout', () => {
        logoutCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    render(<App />);

    const signOut = await screen.findByRole('button', { name: /sign out/i });
    fireEvent.click(signOut);

    await waitFor(() => expect(logoutCalls).toBe(1));
    // After clearing the cache, me refetches and the shell shows the busy state again.
    await screen.findByRole('status', { busy: true });
  });
});
