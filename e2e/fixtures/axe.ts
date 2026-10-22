// Shared axe-core accessibility fixture for the E2E suite (task 13.3, design.md "Testing
// Strategy" → E2E + a11y; Req 24.1, 24.4, 24.12, 25.9).
//
// design.md specifies the exact rule set: the WCAG tags wcag2a, wcag2aa, wcag21a, wcag21aa
// and wcag22aa, with the colour-contrast rule ENABLED, and the build fails on ANY violation
// (Req 24.12). This fixture centralises that policy so every spec scans with identical
// configuration and identical pass/fail semantics.
//
// Honesty about scope (accessibility-auditor guidance): an axe scan is an AUTOMATED check.
// It reliably catches a subset of WCAG issues (missing names, contrast, ARIA misuse,
// landmark/heading problems) but it does NOT establish WCAG 2.2 AA conformance. Full
// conformance requires manual assistive-technology testing (NVDA/VoiceOver), keyboard-only
// passes, 400% zoom and expert review — recorded in docs/a11y-manual-checklist.md. These
// E2E scans are a regression gate, not a conformance claim.
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/** The WCAG rule tags scanned on every state (design.md: wcag2a/aa, wcag21a/aa, wcag22aa). */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** A helper bound to the current page + test, exposing one method: scan a named UI state. */
export interface AxeScanner {
  /**
   * Run axe against the current DOM and assert ZERO violations (design.md: "fail on any
   * violation", Req 24.12). `stateName` is a human label for the UI state being scanned
   * (e.g. "results", "drawer open"); it tags the attached report and the failure message so
   * a CI failure says exactly which state regressed.
   *
   * `include`/`exclude` narrow the scan when a transient third-party/portal node would
   * otherwise add noise unrelated to the state under test; omit them to scan the whole page.
   */
  scan(stateName: string, options?: { include?: string; exclude?: string }): Promise<void>;
}

function buildScanner(page: Page, testInfo: TestInfo): AxeScanner {
  return {
    async scan(stateName, options) {
      let builder = new AxeBuilder({ page }).withTags([...AXE_TAGS]);
      if (options?.include) builder = builder.include(options.include);
      if (options?.exclude) builder = builder.exclude(options.exclude);

      const results = await builder.analyze();

      // Attach the full result set so a failure is debuggable from CI artifacts alone
      // (test-automation-engineer: every failure debuggable without a rerun).
      await testInfo.attach(`axe-${stateName}`, {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
      });

      // Fail on ANY violation, regardless of impact, per design.md / Req 24.12. Build a
      // readable summary (rule id + impact + node count + the help URL) so the assertion
      // message names what broke, not just "expected 0 to be N".
      const summary = results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.length,
        targets: v.nodes.flatMap((n) => n.target),
      }));

      expect(
        results.violations,
        `axe found ${results.violations.length} violation(s) in state "${stateName}":\n` +
          JSON.stringify(summary, null, 2),
      ).toEqual([]);
    },
  };
}

/**
 * The E2E `test` with an `axe` fixture. Import this instead of `@playwright/test`'s `test`
 * in any spec that needs an accessibility scan:
 *
 *   import { test, expect } from './fixtures/axe';
 *   test('idle state is accessible', async ({ page, axe }) => {
 *     await page.goto('/');
 *     await axe.scan('idle');
 *   });
 */
export const test = base.extend<{ axe: AxeScanner }>({
  axe: async ({ page }, use, testInfo) => {
    await use(buildScanner(page, testInfo));
  },
});

export { expect };
