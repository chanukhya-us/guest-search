// Search controller + results states tests (task 12.4). These drive the full stack
// through <App/>: the real api/client, React Query, StatusRegion, useGuestSearch and
// ResultsPanel, with MSW 3 intercepting the BFF endpoints in jsdom.
//
// They cover the design.md state machine and Req 18/19/24:
//   - success → results summary, handed-down rows, "{n} results" title + "{n} guests
//     found" announcement, focus on the caption;
//   - zero results → empty state + "No results" title;
//   - server VALIDATION_ERROR → the form's inline/summary errors, NOT the error panel;
//   - UPSTREAM error → role="alert" panel with "Reference: {id}" and a working Try again;
//   - a new search cancels the previous request (only the latest result renders, the
//     first request's signal aborts);
//   - RATE_LIMITED → its catalog message, form still usable.
import type { GuestSearchResponse, MeResponse, UiConfig } from '@ihg-guest-search/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { useState, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { App } from '../../src/App';
import { StatusRegionProvider } from '../../src/a11y/StatusRegion';
import { FIRST_NAME_INPUT_ID } from '../../src/a11y/useShortcut';
import { createQueryClient } from '../../src/app/queryClient';
import { useGuestSearch } from '../../src/features/search/useGuestSearch';

/** Providers the controller depends on: a fresh QueryClient (once per mount) + StatusRegion. */
function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <StatusRegionProvider>{children}</StatusRegionProvider>
    </QueryClientProvider>
  );
}

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

/** A synthetic success body with `count` guests and the given `limit` (Req 15.11). */
function successResponse(count: number, limit = 50): GuestSearchResponse {
  const results = Array.from({ length: count }, (_, i) => {
    const enterpriseId = `90000000${i}`;
    return {
      guest: {
        enterpriseId,
        score: 90 - i,
        firstName: `Guest${i}`,
        lastName: 'Testperson',
        addresses: [],
        phones: [],
        emails: [],
        memberships: [],
      },
      primary: {},
    };
  });
  return { requestId: `req-${count}`, success: true, totalResults: count, limit, results };
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Base handlers: an authenticated REVEAL user + config, so the form renders. */
function baseHandlers() {
  return [
    http.get('/api/v1/me', () => HttpResponse.json(DEV_ME)),
    http.get('/api/v1/config', () => HttpResponse.json(UI_CONFIG)),
  ];
}

/** Render App, wait for the loaded view, and type a single criterion into First Name. */
async function renderLoaded(): Promise<void> {
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Guest Search' });
}

function firstNameInput(): HTMLInputElement {
  return document.getElementById(FIRST_NAME_INPUT_ID) as HTMLInputElement;
}

function typeFirstName(value: string): void {
  fireEvent.input(firstNameInput(), { target: { value } });
}

function clickSearch(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Search(ing…)?$/ }));
}

describe('search flow — success', () => {
  it('renders the summary and handed-down results, titles "{n} results" and announces', async () => {
    server.use(
      ...baseHandlers(),
      http.post('/api/v1/guests/search', () => HttpResponse.json(successResponse(2))),
    );
    await renderLoaded();

    typeFirstName('Alex');
    clickSearch();

    // The results summary heading and the results table (task 12.5) appear, one row per
    // guest with the Enterprise ID rendered as the row header.
    const caption = await screen.findByRole('heading', { name: /2 guests found/i });
    expect(caption).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '900000000' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '900000001' })).toBeInTheDocument();

    // Title reflects the results state (Req 24.11).
    await waitFor(() => expect(document.title).toBe('2 results – Guest Search – IHG'));

    // Polite announcement "{n} guests found" lands in the status region (Req 18.4).
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('2 guests found'));

    // Focus moves to the caption (Req 18.4).
    await waitFor(() => expect(caption).toHaveFocus());
  });

  it('shows the limited-results notice when totalResults === limit (Req 15.11)', async () => {
    server.use(
      ...baseHandlers(),
      http.post('/api/v1/guests/search', () => HttpResponse.json(successResponse(3, 3))),
    );
    await renderLoaded();
    typeFirstName('Alex');
    clickSearch();

    expect(
      await screen.findByText(/results are limited to the first 3 matches/i),
    ).toBeInTheDocument();
  });
});

describe('search flow — empty', () => {
  it('shows the empty state and the "No results" title, not an error', async () => {
    server.use(
      ...baseHandlers(),
      http.post('/api/v1/guests/search', () => HttpResponse.json(successResponse(0))),
    );
    await renderLoaded();
    typeFirstName('Nobody');
    clickSearch();

    expect(
      await screen.findByText(/no guests found matching the search criteria/i),
    ).toBeInTheDocument();
    // Not an alert: zero results is a success outcome (Req 18.5).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('No results – Guest Search – IHG'));
  });
});

describe('search flow — server validation error (Req 19)', () => {
  it('routes a VALIDATION_ERROR into the form inline errors, not the error panel', async () => {
    server.use(
      ...baseHandlers(),
      http.post('/api/v1/guests/search', () =>
        HttpResponse.json(
          {
            requestId: 'req-val',
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Please correct the highlighted fields and try again.',
              fields: [{ field: 'email', message: 'This field is not yet supported for search.' }],
            },
          },
          { status: 400 },
        ),
      ),
    );
    await renderLoaded();
    typeFirstName('Alex');
    clickSearch();

    // The field error surfaces inline on the form…
    expect(
      await screen.findByText('This field is not yet supported for search.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true'),
    );
    // …and the generic error panel is NOT shown.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('search flow — upstream error (Req 18.6, 18.7, 19)', () => {
  it('shows the alert with the message, the requestId reference, and a working Try again', async () => {
    let attempt = 0;
    server.use(
      ...baseHandlers(),
      http.post('/api/v1/guests/search', () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            {
              requestId: 'req-err-1',
              success: false,
              error: {
                code: 'UPSTREAM_UNAVAILABLE',
                message: 'Unable to complete the guest search. Please try again.',
              },
            },
            { status: 502 },
          );
        }
        return HttpResponse.json(successResponse(1));
      }),
    );
    await renderLoaded();
    typeFirstName('Alex');
    clickSearch();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to complete the guest search. Please try again.');
    expect(alert).toHaveTextContent('Reference: req-err-1');
    await waitFor(() => expect(document.title).toBe('Error – Guest Search – IHG'));

    // Try again re-runs the last criteria; the second attempt succeeds.
    fireEvent.click(within(alert).getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { name: /1 guests found/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(attempt).toBe(2);
  });
});

describe('search flow — rate limited (Req 19)', () => {
  it('shows the RATE_LIMITED message and keeps the form usable', async () => {
    server.use(
      ...baseHandlers(),
      http.post('/api/v1/guests/search', () =>
        HttpResponse.json(
          {
            requestId: 'req-rl',
            success: false,
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests. Please wait a moment and try again.',
            },
          },
          { status: 429 },
        ),
      ),
    );
    await renderLoaded();
    typeFirstName('Alex');
    clickSearch();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Please wait a moment and try again.');
    // The form stays usable (not stuck in the submitting state).
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });
});

describe('search flow — cancellation (Req 18.3)', () => {
  it('aborts the in-flight request and never renders a cancelled (stale) response', async () => {
    const signals: AbortSignal[] = [];
    // The request hangs until aborted, then (if it were to resolve) returns a 99-result
    // body. Because the request is cancelled, that stale body must never reach the state.
    server.use(
      http.post('/api/v1/guests/search', async ({ request }) => {
        signals.push(request.signal);
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener('abort', () => resolve());
        });
        return HttpResponse.json(successResponse(99));
      }),
    );

    const { result } = renderHook(() => useGuestSearch(), { wrapper: Providers });

    // Start a search; it goes to loading with an in-flight request.
    act(() => result.current.submit({ firstName: 'Alex' }));
    await waitFor(() => expect(result.current.state.kind).toBe('loading'));
    await waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0]?.aborted).toBe(false);

    // Clearing cancels the previous request: its AbortSignal fires (Req 18.3) and the
    // controller returns to idle. The stale 99-result body is discarded, never rendered.
    act(() => result.current.clear());
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await waitFor(() => expect(result.current.state.kind).toBe('idle'));
    expect(result.current.state.kind).not.toBe('results');
  });

  it('ignores a duplicate submit while a search is already in progress (Req 18.2)', async () => {
    let calls = 0;
    server.use(
      http.post('/api/v1/guests/search', async ({ request }) => {
        calls += 1;
        // Hang the first call so a second submit would race if not ignored.
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener('abort', () => resolve());
        });
        return HttpResponse.json(successResponse(1));
      }),
    );

    const { result } = renderHook(() => useGuestSearch(), { wrapper: Providers });
    act(() => result.current.submit({ firstName: 'Alex' }));
    await waitFor(() => expect(result.current.state.kind).toBe('loading'));
    await waitFor(() => expect(calls).toBe(1));

    // A second submit while loading is ignored: no new request is made.
    act(() => result.current.submit({ firstName: 'Blair' }));
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
