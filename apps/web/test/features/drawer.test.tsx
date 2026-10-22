// Guest details drawer + reveal flow tests (task 12.7, Req 16, 14).
//
// These drive the full stack through <App/>: the real api/client, React Query, the app
// shell's drawer wiring and reveal map, and the ResultsTable / GuestDetailsDrawer, with
// MSW 3 intercepting the BFF endpoints in jsdom. They cover:
//   - opening the drawer from a row shows the guest's full MASKED record and marks the
//     primary of each collection in text (Req 16.2, 16.5);
//   - the drawer is a modal dialog (aria-modal) and Close / Escape return focus to the
//     "View details" trigger (Req 16.3, 16.4);
//   - a reveal-capable colleague sees the reveal button; activating it calls the reveal
//     API, swaps in the unmasked phones/emails and announces the change (Req 14.12);
//   - a REVEAL_EXPIRED response shows the inline expired message and keeps the masked
//     view (Req 14.14);
//   - a read-only colleague (no role / no token) never sees the reveal control (Req 14.15);
//   - revealed values are discarded on a new search: reopening the row shows masks again
//     (Req 14.13, 21.7).
import type {
  GuestSearchResponse,
  MeResponse,
  RevealResponse,
  UiConfig,
} from '@ihg-guest-search/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { App } from '../../src/App';
import { FIRST_NAME_INPUT_ID } from '../../src/a11y/useShortcut';

const REVEAL_ME: MeResponse = {
  displayName: 'Dana Example',
  roles: ['GuestSearch.Read', 'GuestSearch.RevealPII'],
  authMode: 'dev',
};

const READONLY_ME: MeResponse = {
  displayName: 'Robin Readonly',
  roles: ['GuestSearch.Read'],
  authMode: 'dev',
};

const UI_CONFIG: UiConfig = {
  scoreBands: { high: 90, medium: 70 },
  memberTypes: [{ code: 'PC', label: 'Platinum' }],
  features: { addressLine1: false, city: false, postalCode: false },
  authMode: 'dev',
};

/** A single guest with multiple addresses / phones / emails / memberships, masked, and a
 *  reveal token present only when `withToken` (the BFF omits it for read-only users). */
function oneGuestResponse(withToken: boolean): GuestSearchResponse {
  return {
    requestId: 'req-1',
    success: true,
    totalResults: 1,
    limit: 50,
    results: [
      {
        guest: {
          enterpriseId: '900000001',
          score: 95,
          firstName: 'Alex',
          lastName: 'Testperson',
          addresses: [
            {
              line1: '1 Example St',
              city: 'Atlanta',
              stateOrRegion: 'GA',
              postalCode: '30301',
              country: 'US',
              profileDefault: true,
            },
            { line1: '2 Second Ave', city: 'Denver', country: 'US' },
          ],
          phones: [{ number: '•••• 0101', profileDefault: true }, { number: '•••• 0202' }],
          emails: [{ address: 'a•••@example.test', profileDefault: true }],
          memberships: [{ memberId: '900000101', memberType: 'PC', status: 'A' }],
        },
        primary: {
          address: {
            line1: '1 Example St',
            city: 'Atlanta',
            stateOrRegion: 'GA',
            postalCode: '30301',
            country: 'US',
            profileDefault: true,
          },
          phone: { number: '•••• 0101', profileDefault: true },
          email: { address: 'a•••@example.test', profileDefault: true },
          membership: { memberId: '900000101', memberType: 'PC', status: 'A' },
        },
        ...(withToken ? { revealToken: 'rt_token_1' } : {}),
      },
    ],
  };
}

const REVEALED: RevealResponse = {
  requestId: 'req-reveal',
  phones: [{ number: '+1 404 555 0101', profileDefault: true }, { number: '+1 404 555 0202' }],
  emails: [{ address: 'alex@example.test', profileDefault: true }],
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function searchHandlers(me: MeResponse, withToken: boolean) {
  return [
    http.get('/api/v1/me', () => HttpResponse.json(me)),
    http.get('/api/v1/config', () => HttpResponse.json(UI_CONFIG)),
    http.post('/api/v1/guests/search', () => HttpResponse.json(oneGuestResponse(withToken))),
  ];
}

function firstNameInput(): HTMLInputElement {
  return document.getElementById(FIRST_NAME_INPUT_ID) as HTMLInputElement;
}

/** Render App, run a search that returns one guest, and wait for the row. */
async function renderWithResult(me: MeResponse, withToken: boolean): Promise<void> {
  server.use(...searchHandlers(me, withToken));
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Guest Search' });
  fireEvent.input(firstNameInput(), { target: { value: 'Alex' } });
  fireEvent.click(screen.getByRole('button', { name: /^Search(ing…)?$/ }));
  await screen.findByRole('rowheader', { name: '900000001' });
}

function openDrawer(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /view details for alex testperson/i });
  // A real pointer click focuses the button before activating it; jsdom's fireEvent.click
  // does not, so focus it explicitly. React Aria restores focus to whatever was focused
  // when the modal opened, so this is what makes the focus-return assertion meaningful.
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

/** The always-mounted polite live region. While the modal is open React Aria sets
 *  aria-hidden on it (so getByRole can't see it), so read the node directly. */
function statusRegionText(): string {
  return document.querySelector('[role="status"]')?.textContent ?? '';
}

describe('details drawer — open and content (Req 16.2, 16.5)', () => {
  it('opens a modal dialog showing every collection, masked, with primaries marked', async () => {
    await renderWithResult(REVEAL_ME, true);
    openDrawer();

    const dialog = await screen.findByRole('dialog');
    // The modal exposes aria-modal="true" (Req 16.3); React Aria renders it on the modal
    // container wrapping the dialog, so assert on the element carrying the attribute.
    const modal = document.querySelector('[aria-modal="true"]');
    expect(modal).not.toBeNull();
    expect(modal).toContainElement(dialog);

    // All addresses are shown (both), not just the primary.
    expect(within(dialog).getByText('1 Example St')).toBeInTheDocument();
    expect(within(dialog).getByText('2 Second Ave')).toBeInTheDocument();

    // Both masked phones and the masked email are shown verbatim; nothing unmasked.
    expect(within(dialog).getByText('•••• 0101')).toBeInTheDocument();
    expect(within(dialog).getByText('•••• 0202')).toBeInTheDocument();
    expect(within(dialog).getByText('a•••@example.test')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/alex@example\.test/i);

    // Membership details appear.
    expect(within(dialog).getByText('900000101')).toBeInTheDocument();

    // The primary of each collection is marked in text (not colour alone).
    expect(within(dialog).getAllByText('Primary').length).toBeGreaterThanOrEqual(1);
  });
});

describe('details drawer — focus management (Req 16.3, 16.4)', () => {
  it('returns focus to the View details trigger when closed via the Close button', async () => {
    await renderWithResult(REVEAL_ME, true);
    const trigger = openDrawer();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /close guest details/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes and returns focus to the trigger on Escape', async () => {
    await renderWithResult(REVEAL_ME, true);
    const trigger = openDrawer();
    const dialog = await screen.findByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('reveal — capable colleague (Req 14.12)', () => {
  it('shows the reveal button, reveals unmasked values and announces the change', async () => {
    server.use(http.post('/api/v1/guests/reveal', () => HttpResponse.json(REVEALED)));
    await renderWithResult(REVEAL_ME, true);
    openDrawer();
    const dialog = await screen.findByRole('dialog');

    const revealBtn = within(dialog).getByRole('button', {
      name: /reveal contact details for alex testperson/i,
    });
    fireEvent.click(revealBtn);

    // Unmasked values swap in; the masked forms disappear from the drawer.
    expect(await within(dialog).findByText('+1 404 555 0101')).toBeInTheDocument();
    expect(within(dialog).getByText('+1 404 555 0202')).toBeInTheDocument();
    expect(within(dialog).getByText('alex@example.test')).toBeInTheDocument();
    expect(within(dialog).queryByText('•••• 0101')).not.toBeInTheDocument();

    // The reveal is announced politely in the live region.
    await waitFor(() => expect(statusRegionText()).toMatch(/contact details revealed/i));
  });

  it('shows the inline expired message and keeps masks on REVEAL_EXPIRED (Req 14.14)', async () => {
    server.use(
      http.post('/api/v1/guests/reveal', () =>
        HttpResponse.json(
          {
            requestId: 'req-exp',
            success: false,
            error: { code: 'REVEAL_EXPIRED', message: 'Reveal token has expired.' },
          },
          { status: 404 },
        ),
      ),
    );
    await renderWithResult(REVEAL_ME, true);
    openDrawer();
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(
      within(dialog).getByRole('button', { name: /reveal contact details for alex testperson/i }),
    );

    expect(
      await within(dialog).findByText('Details expired. Please search again.'),
    ).toBeInTheDocument();
    // Masked values are still shown; the reveal button is not offered again.
    expect(within(dialog).getByText('•••• 0101')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /reveal contact details/i }),
    ).not.toBeInTheDocument();
  });
});

describe('reveal — read-only colleague (Req 14.15)', () => {
  it('never shows the reveal control without the role or a token', async () => {
    await renderWithResult(READONLY_ME, false);
    openDrawer();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).queryByRole('button', { name: /reveal contact details/i }),
    ).not.toBeInTheDocument();
    // The masked values remain.
    expect(within(dialog).getByText('•••• 0101')).toBeInTheDocument();
  });
});

describe('reveal — no persistence (Req 14.13, 21.7)', () => {
  it('discards revealed values on a new search; reopening shows masks again', async () => {
    server.use(http.post('/api/v1/guests/reveal', () => HttpResponse.json(REVEALED)));
    await renderWithResult(REVEAL_ME, true);
    openDrawer();
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: /reveal contact details for alex testperson/i }),
    );
    expect(await within(dialog).findByText('+1 404 555 0101')).toBeInTheDocument();

    // Close the drawer, then run a NEW search (same fixture). The reveal map is cleared.
    fireEvent.click(within(dialog).getByRole('button', { name: /close guest details/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.input(firstNameInput(), { target: { value: 'Alex2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search(ing…)?$/ }));
    // Wait for the second search to settle (the button returns to "Search") before the
    // row re-renders, so we don't race the loading state.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled());
    await screen.findByRole('button', { name: /view details for alex testperson/i });

    openDrawer();
    dialog = await screen.findByRole('dialog');
    // Masked again; the unmasked value is gone (not persisted across the new search).
    expect(within(dialog).getByText('•••• 0101')).toBeInTheDocument();
    expect(within(dialog).queryByText('+1 404 555 0101')).not.toBeInTheDocument();
  });
});
