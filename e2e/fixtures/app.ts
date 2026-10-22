// Shared E2E page helpers (task 13.3). Role/label-first locators and small flow helpers so
// specs read as user journeys, survive refactors, and never duplicate selector strings
// (test-automation-engineer: select like a user, data-testid only as an escape hatch).
//
// These helpers wrap the REAL app semantics observed in apps/web/src:
//   - the search form is <form aria-label="Guest search"> with labelled fields
//     ("First name", "Last name", …), a "Search" submit and a "Clear" button;
//   - results render in a <section aria-label="Search results"> with an <h2> summary
//     "{n} guests found" and a <table> with a <caption>;
//   - empty / error states and the drawer carry the exact copy asserted here.
import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/** A seed last name that returns real matches from the Node mock (tools/mock-soap/seed.ts). */
export const MATCHING_LAST_NAME = 'Anderson';

/** Magic surnames the mock recognises (tools/mock-soap/handler.ts). */
export const MAGIC = {
  /** 0 guests, successful empty result. */
  empty: 'nomatch',
  /** SOAP Fault → UPSTREAM_FAULT → error panel. */
  fault: 'fault',
  /** All 60 seed guests (alias of "boom") → exercises pagination (Req 17). */
  many: 'many',
} as const;

export class SearchPage {
  constructor(readonly page: Page) {}

  // --- landmarks & shell ----------------------------------------------------------------

  get main(): Locator {
    return this.page.locator('main#main');
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { level: 1, name: 'Guest Search' });
  }

  get skipLink(): Locator {
    return this.page.getByRole('link', { name: 'Skip to main content' });
  }

  get form(): Locator {
    return this.page.getByRole('form', { name: 'Guest search' });
  }

  get firstNameInput(): Locator {
    return this.page.getByLabel('First name', { exact: true });
  }

  get lastNameInput(): Locator {
    return this.page.getByLabel('Last name', { exact: true });
  }

  get searchButton(): Locator {
    // Accessible name flips to "Searching…" while a request is in flight.
    return this.page.getByRole('button', { name: /^(Search|Searching)/ });
  }

  get clearButton(): Locator {
    return this.page.getByRole('button', { name: 'Clear' });
  }

  get resultsRegion(): Locator {
    return this.page.getByRole('region', { name: 'Search results' });
  }

  get errorAlert(): Locator {
    // The error panel is role="alert" with an <h2> "Search failed".
    return this.page.getByRole('alert').filter({ hasText: 'Search failed' });
  }

  get tryAgainButton(): Locator {
    return this.page.getByRole('button', { name: 'Try again' });
  }

  get resultsTable(): Locator {
    return this.page.getByRole('table');
  }

  get resultsSummaryHeading(): Locator {
    return this.page.getByRole('heading', { name: /\d+ guests found/ });
  }

  /** Wait for the shell to finish its startup load (me + config) and the form to appear. */
  async waitReady(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.form).toBeVisible();
  }

  /** Type a last name and submit the form. */
  async searchByLastName(value: string): Promise<void> {
    await this.lastNameInput.fill(value);
    await this.searchButton.click();
  }

  /** The "View details" button for a given row, located by its accessible name. */
  viewDetailsFor(nameFragment: string): Locator {
    return this.page.getByRole('button', {
      name: new RegExp(`View details for .*${nameFragment}`),
    });
  }

  get drawer(): Locator {
    return this.page.getByRole('dialog');
  }

  get closeDrawerButton(): Locator {
    return this.page.getByRole('button', { name: 'Close guest details' });
  }
}

/** Build a SearchPage, open the app and wait until it is interactive. */
export async function openApp(page: Page): Promise<SearchPage> {
  const sp = new SearchPage(page);
  await page.goto('/');
  await sp.waitReady();
  return sp;
}
