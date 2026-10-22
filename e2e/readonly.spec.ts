// Reveal role OFF (task 13.3, Req 25.9 "reveal … role off in a second dev-user config";
// Req 14.12, 14.15). This spec runs ONLY against the read-only stack (DEV_AUTH_PERSONA=
// read.only), wired by the `chromium-readonly` project in playwright.config.ts.
//
// A read-only colleague holds GuestSearch.Read but NOT GuestSearch.RevealPII. The BFF
// therefore issues no reveal token, and the UI shows no reveal affordance anywhere — in the
// results rows or in the details drawer. Contacts stay masked. This proves the role gate is
// enforced end to end, not just in the component props.
import { expect, test } from '@playwright/test';

import { MATCHING_LAST_NAME, openApp } from './fixtures/app';

test.describe('reveal role off (read-only persona)', () => {
  test('the header shows read-only access and no reveal affordance appears', async ({ page }) => {
    const sp = await openApp(page);

    // The utility bar reflects the read-only persona's role label.
    await expect(page.getByText('Search access')).toBeVisible();

    await sp.searchByLastName(MATCHING_LAST_NAME);
    await expect(sp.resultsTable).toBeVisible();

    // No per-row reveal button anywhere in the table.
    await expect(page.getByRole('button', { name: /^Reveal contact details/ })).toHaveCount(0);

    // Masked contacts remain (the @example.test domain is shown but the phone stays masked).
    const firstRow = sp.resultsTable.locator('tbody tr').first();
    await expect(firstRow.getByText(/•••• \d{2}/)).toBeVisible();

    // The drawer likewise offers no reveal control.
    await firstRow.getByRole('button', { name: /^View details/ }).click();
    const drawer = sp.drawer;
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: /^Reveal contact details/ })).toHaveCount(0);
  });
});
