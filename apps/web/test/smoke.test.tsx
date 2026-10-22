// Web app foundation smoke test (task 12.1), kept as a brand-token sanity check.
//
// Rendering-based landmark/heading assertions moved to test/app/shell.test.tsx once the
// shell gained async startup (useMe / useUiConfig) in task 12.2 — those need network
// mocks. This file stays a fast, dependency-free check that the required IHG brand
// tokens are defined (Req 23.2), read straight from the stylesheet source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('web app brand tokens', () => {
  it('defines the IHG brand tokens (Req 23.2)', () => {
    // Vitest does not transform CSS, so assert the token definitions from source
    // rather than computed styles.
    const tokensCss = readFileSync(join(import.meta.dirname, '../src/styles/tokens.css'), 'utf8');

    // Core brand colours must be present as CSS custom properties.
    expect(tokensCss).toContain('--ihg-orange-600: #c7370f');
    expect(tokensCss).toContain('--ihg-orange-800: #940400');
    expect(tokensCss).toContain('--ihg-navy-700: #1f4456');
    // The error/success semantics and a surface token, to cover Req 23.2 breadth.
    // --error-600 is #c0392b (darkened from #ce4635) so normal-size error text clears the
    // WCAG 1.4.3 4.5:1 minimum on the error wash; the E2E axe scan enforces this.
    expect(tokensCss).toContain('--error-600: #c0392b');
    expect(tokensCss).toContain('--success-700: #007a52');
    // Inter is the configured family (self-hosted; Req 23.3).
    expect(tokensCss).toContain('Inter Variable');
  });
});
