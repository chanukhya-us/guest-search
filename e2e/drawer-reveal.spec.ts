// Details drawer + reveal flow (task 13.3, Req 25.9 "details drawer" and "reveal", Req 16,
// 14; design.md axe states: "drawer open", "revealed").
//
// Runs against the default stack (jane.doe), which holds GuestSearch.RevealPII, so the row
// and drawer both offer "Reveal contact details". The reveal path is end to end: the browser
// exchanges the opaque reveal token at the BFF, the BFF returns the unmasked phones/emails
// held server-side for the session, and the UI swaps the masked values for the unmasked ones.
import { test, expect } from './fixtures/axe';
import { MATCHING_LAST_NAME, openApp } from './fixtures/app';

/** Full unmasked phone shape the mock seeds (+1 404 555 01xx). */
const UNMASKED_PHONE = /\+1 404 555 01\d{2}/;
/** The masked phone shape shown by default (•••• 01xx). */
const MASKED_PHONE = /•••• \d{2}/;

test.describe('details drawer and reveal', () => {
  test('opens the drawer with the full masked record and the primary marked', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MATCHING_LAST_NAME);
    await expect(sp.resultsTable).toBeVisible();

    // Open the first row's details drawer.
    const firstRow = sp.resultsTable.locator('tbody tr').first();
    await firstRow.getByRole('button', { name: /^View details/ }).click();

    // The drawer is a modal dialog, labelled by the guest name, with Enterprise ID and the
    // collection sections (Addresses / Phones / Emails / Memberships).
    const drawer = sp.drawer;
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(drawer.getByText(/Enterprise ID: \S+/)).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Phones', level: 3 })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Emails', level: 3 })).toBeVisible();
    // The primary of a collection is marked in TEXT, not colour alone (Req 16.2, 24.5).
    await expect(drawer.getByText('Primary').first()).toBeVisible();
    // Contacts are masked until reveal (Req 16.5).
    await expect(drawer.getByText(MASKED_PHONE).first()).toBeVisible();

    await axe.scan('drawer open');

    // Esc closes the drawer and returns focus to the "View details" trigger (Req 16.4).
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(firstRow.getByRole('button', { name: /^View details/ })).toBeFocused();
  });

  test('reveal in the drawer replaces masked contacts with the unmasked phone and email', async ({
    page,
    axe,
  }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MATCHING_LAST_NAME);
    await expect(sp.resultsTable).toBeVisible();

    const firstRow = sp.resultsTable.locator('tbody tr').first();
    await firstRow.getByRole('button', { name: /^View details/ }).click();
    const drawer = sp.drawer;
    await expect(drawer).toBeVisible();

    // The reveal control is offered to a REVEAL-role colleague (Req 14.15); its accessible
    // name includes the guest name.
    const revealButton = drawer.getByRole('button', { name: /^Reveal contact details for / });
    await expect(revealButton).toBeVisible();

    await revealButton.click();

    // After the token exchange, the full unmasked phone appears and the mask is gone from
    // the revealed phone (Req 14.7, 16.5). The @example.test domain remains (it is always
    // shown, even masked), so we assert the unmasked phone to prove the swap happened.
    await expect(drawer.getByText(UNMASKED_PHONE).first()).toBeVisible();
    // The reveal button is not offered again once revealed (Req 14.12).
    await expect(drawer.getByRole('button', { name: /^Reveal contact details for / })).toHaveCount(
      0,
    );

    await axe.scan('revealed');
  });

  test('reveal from a results row unmasks that row in place', async ({ page }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MATCHING_LAST_NAME);
    await expect(sp.resultsTable).toBeVisible();

    const firstRow = sp.resultsTable.locator('tbody tr').first();
    // The per-row reveal button names the guest too.
    const rowReveal = firstRow.getByRole('button', { name: /^Reveal contact details for / });
    await expect(rowReveal).toBeVisible();
    await rowReveal.click();

    // The row's masked phone is replaced by the unmasked value.
    await expect(firstRow.getByText(UNMASKED_PHONE)).toBeVisible();
  });
});
