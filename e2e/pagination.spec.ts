// Pagination over 60 results (task 13.3, Req 25.9 "pagination across 51 or more results",
// Req 17; design.md axe state: "page 2").
//
// The mock's magic surname "many" returns all 60 seed guests, which with the default page
// size of 50 produces 2 pages — enough to exercise Prev/Next, numbered controls, the page
// select and the range text, and the focus/announcement on a page change.
import { test, expect } from './fixtures/axe';
import { MAGIC, openApp } from './fixtures/app';

test.describe('pagination', () => {
  test('60 results paginate: range text, page 2 navigation, and the numbered controls', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MAGIC.many);

    await expect(sp.resultsSummaryHeading).toBeVisible();
    await expect(sp.resultsSummaryHeading).toHaveText('60 guests found');

    const pagination = page.getByRole('navigation', { name: 'Search results pagination' });
    await expect(pagination).toBeVisible();

    // Page 1 range text (Req 17.5): "Showing 1–50 of 60 guests".
    const range = page.getByTestId('pagination-range');
    await expect(range).toHaveText(/Showing 1[–-]50 of 60 guests/);

    // Page 1: Previous is disabled (Req 17.6), 50 rows render.
    const prev = pagination.getByRole('button', { name: 'Previous page' });
    const next = pagination.getByRole('button', { name: 'Next page' });
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await expect(sp.resultsTable.locator('tbody tr')).toHaveCount(50);

    // Navigate to page 2 via the numbered control (Req 17.3).
    await pagination.getByRole('button', { name: 'Go to page 2' }).click();

    // Range text updates to the remaining 10 (Req 17.5) and the current page is marked.
    await expect(range).toHaveText(/Showing 51[–-]60 of 60 guests/);
    await expect(pagination.getByRole('button', { name: 'Page 2, current page' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(sp.resultsTable.locator('tbody tr')).toHaveCount(10);

    // On page 2: Next is disabled (last page, Req 17.7), Previous is enabled.
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();

    // Scan the page-2 state (design.md axe state "page 2").
    await axe.scan('page 2');

    // Prev returns to page 1 and restores the first range + row count.
    await prev.click();
    await expect(range).toHaveText(/Showing 1[–-]50 of 60 guests/);
    await expect(sp.resultsTable.locator('tbody tr')).toHaveCount(50);
  });
});
