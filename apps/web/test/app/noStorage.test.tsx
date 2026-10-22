// No-Web-Storage test (task 12.8, Req 14.13 / 21.7).
//
// The app must never persist guest data (or anything else) to localStorage or
// sessionStorage: session state lives in the signed HttpOnly cookie, results and reveals
// live only in memory. This spies on Storage.prototype.setItem across a full, realistic
// journey — load, search, open the drawer, change sort, paginate — and asserts it is
// never called. React Query is configured with no persister, so a regression that adds
// client-side caching to storage would trip this.
import type { GuestSearchResponse, MeResponse, UiConfig } from '@ihg-guest-search/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import { FIRST_NAME_INPUT_ID } from '../../src/a11y/useShortcut';

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

/** 60 synthetic guests so pagination (2 pages at size 50) is exercised. */
function successResponse(count: number): GuestSearchResponse {
  const results = Array.from({ length: count }, (_u, i) => ({
    guest: {
      enterpriseId: `9${String(i).padStart(8, '0')}`,
      score: count - i,
      firstName: `Guest${i}`,
      lastName: `Last${i}`,
      addresses: [],
      phones: [],
      emails: [],
      memberships: [],
    },
    primary: {},
  }));
  return { requestId: `req-${count}`, success: true, totalResults: count, limit: 100, results };
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Both localStorage and sessionStorage inherit setItem from Storage.prototype, so a single
// spy there catches a write to either store.
let setItemSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
});

afterEach(() => {
  setItemSpy.mockRestore();
});

function firstNameInput(): HTMLInputElement {
  return document.getElementById(FIRST_NAME_INPUT_ID) as HTMLInputElement;
}

describe('no Web Storage writes (Req 14.13, 21.7)', () => {
  it('never calls Storage.setItem across load, search, sort and paginate', async () => {
    server.use(
      http.get('/api/v1/me', () => HttpResponse.json(DEV_ME)),
      http.get('/api/v1/config', () => HttpResponse.json(UI_CONFIG)),
      http.post('/api/v1/guests/search', () => HttpResponse.json(successResponse(60))),
    );

    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Guest Search' });

    // Run a search that returns 60 results (two pages).
    fireEvent.input(firstNameInput(), { target: { value: 'Guest' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search(ing…)?$/ }));
    await screen.findByRole('heading', { name: /60 guests found/i });

    // Change the sort.
    fireEvent.click(screen.getByRole('button', { name: /last name/i }));
    // Page to the second page.
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    await screen.findByText(/Showing 51–60 of 60 guests/);

    // Storage.setItem must not have been touched at any point (local or session).
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});
