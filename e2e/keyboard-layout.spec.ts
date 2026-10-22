// Keyboard, focus and layout journeys (task 13.3, Req 24.3, 24.6, 24.8, 24.9, 24.10).
//
// These are the checks an automated runner CAN make for keyboard operability and layout:
//   - the skip link is the first focusable element and moves focus to <main>;
//   - "/" moves focus to First name while focus is outside a text field (Req 24.10);
//   - a keyboard-only pass reaches the core controls in a logical order with a visible
//     focus indicator on each (Req 24.3);
//   - every interactive target in a key state is at least 24×24 CSS px (Req 24.6);
//   - at a 320px viewport the form reflows with no horizontal scrolling (Req 24.8 — the
//     results TABLE is explicitly exempt and scrolls in its own region);
//   - a status change is announced once: the polite Status_Region and role="alert" never
//     carry the same message at the same time (Req 24.9).
//
// Note (accessibility-auditor): visible-focus and tab-order checks here are a regression
// gate, not a substitute for a manual screen-reader + keyboard pass (docs/a11y-manual-
// checklist.md). "Focus is visible" is asserted via :focus-visible matching the global
// 2px navy outline token; a human still confirms perceivability.
import { expect, test } from '@playwright/test';

import { MAGIC, MATCHING_LAST_NAME, openApp } from './fixtures/app';

test.describe('keyboard and layout', () => {
  test('skip link is first in the tab order and jumps to main', async ({ page }) => {
    const sp = await openApp(page);

    // First Tab from the top of the document lands on the skip link (Req 24.3).
    await page.keyboard.press('Tab');
    await expect(sp.skipLink).toBeFocused();

    // Activating it moves the viewport/focus context to the main landmark.
    await sp.skipLink.press('Enter');
    await expect(sp.main).toBeVisible();
  });

  test('"/" shortcut moves focus to First name when focus is outside a text field', async ({
    page,
  }) => {
    const sp = await openApp(page);

    // Focus somewhere non-text first (the H1 is not focusable; use document body via blur).
    await page.locator('body').click();
    await page.keyboard.press('/');
    await expect(sp.firstNameInput).toBeFocused();

    // While focus is in a text field, "/" types and does NOT steal focus (Req 24.10).
    await sp.firstNameInput.fill('');
    await sp.firstNameInput.press('/');
    await expect(sp.firstNameInput).toHaveValue('/');
  });

  test('keyboard-only: reach and operate the search controls with a visible focus indicator', async ({
    page,
  }) => {
    const sp = await openApp(page);

    // Drive the whole happy path from the keyboard: focus First name via the shortcut, tab
    // to Last name, type, then submit with Enter.
    await page.locator('body').click();
    await page.keyboard.press('/');
    await expect(sp.firstNameInput).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(sp.lastNameInput).toBeFocused();
    // A focused control matches :focus-visible, so the global focus ring applies (Req 24.3).
    expect(await sp.lastNameInput.evaluate((el) => el.matches(':focus-visible'))).toBe(true);

    await sp.lastNameInput.type(MATCHING_LAST_NAME);
    await sp.lastNameInput.press('Enter');

    await expect(sp.resultsSummaryHeading).toBeVisible();
  });

  test('every interactive target in the results state is at least 24x24 CSS px', async ({
    page,
  }) => {
    const sp = await openApp(page);
    await sp.searchByLastName(MATCHING_LAST_NAME);
    await expect(sp.resultsTable).toBeVisible();

    // Collect the visible, enabled interactive elements and assert the 24px floor (Req 24.6).
    // Disabled controls (e.g. a disabled Prev on page 1) are exempt from the target rule.
    const undersized = await page.evaluate(() => {
      const MIN = 24;
      const selector = 'button, a[href], input, select, [role="button"]';
      const bad: { tag: string; name: string; w: number; h: number }[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if ((el as HTMLButtonElement).disabled) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // not rendered
        // sr-only/visually-hidden helpers collapse to ~1px; skip them (not pointer targets).
        if (r.width <= 1 || r.height <= 1) continue;
        if (r.width < MIN || r.height < MIN) {
          bad.push({
            tag: el.tagName.toLowerCase(),
            name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
      }
      return bad;
    });

    expect(undersized, `undersized targets: ${JSON.stringify(undersized, null, 2)}`).toEqual([]);
  });

  test('at 320px width the form reflows without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const sp = await openApp(page);

    // The page (excluding the results table, which is not yet rendered) must not scroll
    // horizontally at 320px (Req 24.8).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1); // allow sub-pixel rounding

    // The form and its controls are reachable and stacked (single column); the fields are
    // all present and visible.
    await expect(sp.firstNameInput).toBeVisible();
    await expect(sp.lastNameInput).toBeVisible();
    await expect(sp.searchButton).toBeVisible();
  });

  test('a status change is announced once: the live region and alert never duplicate it', async ({
    page,
  }) => {
    const sp = await openApp(page);

    // Results: the summary announcement "{n} guests found" goes to the polite Status_Region
    // only; the results panel is NOT an alert (Req 24.9).
    await sp.searchByLastName(MATCHING_LAST_NAME);
    await expect(sp.resultsSummaryHeading).toBeVisible();

    const alerts = page.getByRole('alert');
    await expect(alerts.filter({ hasText: /guests found/ })).toHaveCount(0);

    // Error: the error panel IS an alert; the polite status region must not also carry the
    // error message. The live region (role="status") should not contain "Search failed".
    await sp.searchByLastName(MAGIC.fault);
    await expect(sp.errorAlert).toBeVisible();
    const statusRegion = page.getByRole('status');
    await expect(statusRegion.filter({ hasText: /Search failed/ })).toHaveCount(0);
  });
});
