// Core search journeys + accessibility scans (task 13.3, Req 25.9: search with results,
// zero results, validation error, upstream error with Try again; design.md axe states:
// initial, invalid, results, empty, error).
//
// Runs against the default stack (jane.doe, reveal-capable) served on the project baseURL.
import { test, expect } from './fixtures/axe';
import { MAGIC, MATCHING_LAST_NAME, openApp } from './fixtures/app';

test.describe('core search flows', () => {
  test('loads the idle app: header, heading, empty results region, a search form', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);

    // Shell: the two-tier header (brand bar shows the product title), the page H1 and the
    // intro are present, and the results region is idle (no table, no empty/error panel).
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(sp.heading).toBeVisible();
    await expect(sp.form).toBeVisible();
    await expect(sp.firstNameInput).toBeVisible();
    await expect(sp.lastNameInput).toBeVisible();
    await expect(sp.searchButton).toBeVisible();
    // Idle: the results section is mounted (aria-label) but shows nothing yet.
    await expect(sp.resultsTable).toHaveCount(0);
    await expect(page.getByText('No guests found')).toHaveCount(0);

    // Idle page title (Req 24.11): "Search – Guest Search – IHG".
    await expect(page).toHaveTitle('Search – Guest Search – IHG');

    await axe.scan('idle');
  });

  test('happy path: a matching last name shows the results table, summary, masked contacts and score bands', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MATCHING_LAST_NAME);

    // Summary heading "{n} guests found" (Req 18.4) and the table appear.
    await expect(sp.resultsSummaryHeading).toBeVisible();
    await expect(sp.resultsTable).toBeVisible();

    // The caption carries the sorted-by-score range text (Req 15.3).
    await expect(
      page.getByText(/Search results: \d+ guests?, sorted by match score/),
    ).toBeVisible();

    // At least one data row with the expected columns. Match score column + a score-band
    // chip ("High"/"Medium"/"Low") are shown as TEXT, never colour alone (Req 15.6, 24.5).
    const firstRow = sp.resultsTable.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow.getByText(/High|Medium|Low/)).toBeVisible();

    // PII is masked by default (Req 14): the seed email domain is @example.test, and a
    // masked email shows masking characters rather than the full local part.
    const bodyText = await sp.resultsTable.locator('tbody').innerText();
    expect(bodyText).toContain('@example.test');
    expect(bodyText).toMatch(/[•*]/); // masking glyph present somewhere in the masked contacts

    // Result page title reflects the state (Req 24.11): "{n} results – Guest Search – IHG".
    await expect(page).toHaveTitle(/\d+ results – Guest Search – IHG/);

    await axe.scan('results');
  });

  test('loading: the in-flight state shows the busy skeleton and is accessible', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);

    // Delay the search response so the loading state is observable long enough to scan it.
    // We let the real request through after a short pause (route.continue after a wait),
    // so the flow still completes normally afterwards.
    await page.route('**/api/v1/guests/search', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await sp.lastNameInput.fill(MATCHING_LAST_NAME);
    await sp.searchButton.click();

    // The results region is aria-busy and the submit button shows "Searching…" (Req 18.1).
    await expect(sp.resultsRegion).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Searching…' })).toBeVisible();
    await expect(page).toHaveTitle('Searching – Guest Search – IHG');

    await axe.scan('loading');

    // Let it finish so the test ends in a clean state.
    await expect(sp.resultsSummaryHeading).toBeVisible();
  });

  test('empty: a non-matching last name shows the "No guests found" empty state', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MAGIC.empty);

    // The empty state is NOT an alert (zero results is a success outcome, design.md).
    await expect(page.getByRole('heading', { name: 'No guests found' })).toBeVisible();
    await expect(page.getByText('No guests found matching the search criteria.')).toBeVisible();
    await expect(sp.resultsTable).toHaveCount(0);

    await expect(page).toHaveTitle('No results – Guest Search – IHG');

    await axe.scan('empty');
  });

  test('error + retry: an upstream fault shows the error alert with a Reference and Try again', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MAGIC.fault);

    // The error panel is role="alert" with the catalog message, a support reference and a
    // Try again control (Req 18.6, 18.7). It never shows the error code or stack (Req 19.3).
    await expect(sp.errorAlert).toBeVisible();
    await expect(sp.errorAlert.getByText(/Reference: \S+/)).toBeVisible();
    await expect(sp.tryAgainButton).toBeVisible();

    await expect(page).toHaveTitle('Error – Guest Search – IHG');

    // Scan the error state before recovering.
    await axe.scan('error');

    // Recover: change the criterion to a matching name, then Try again re-runs the LAST
    // criteria — so we first prove Try again re-runs the fault, then type a good name and
    // search again to confirm the app recovers to a results state.
    await sp.tryAgainButton.click();
    await expect(sp.errorAlert).toBeVisible();

    await sp.lastNameInput.fill(MATCHING_LAST_NAME);
    await sp.searchButton.click();
    await expect(sp.resultsSummaryHeading).toBeVisible();
    await expect(sp.errorAlert).toHaveCount(0);
  });

  test('client validation: an all-blank submit shows the error summary, focuses it, and makes no request', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);

    // Prove no /search request leaves the browser on an invalid (empty) submit (Req 4.1).
    let searchRequested = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/guests/search')) searchRequested = true;
    });

    await sp.searchButton.click();

    // The ErrorSummary appears and its heading ("There is 1 problem…") receives focus so a
    // keyboard/screen-reader user lands on it (Req 5.2). It is intentionally NOT a live
    // region — moving focus here is the single announcement (design.md "Focus and
    // announcements"), so we assert the focused heading, not role="alert".
    const summaryHeading = page.getByRole('heading', { name: /problem(s)? with your search/i });
    await expect(summaryHeading).toBeVisible();
    await expect(summaryHeading).toBeFocused();

    // The NO_CRITERIA message is linked in the summary and targets the First Name input
    // (Req 5.3).
    await expect(
      page.getByRole('link', { name: /Search criteria:.*at least one search criterion/i }),
    ).toBeVisible();

    expect(searchRequested).toBe(false);

    await axe.scan('invalid');
  });
});
