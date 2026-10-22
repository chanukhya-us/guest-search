// countryOptions unit tests (Req 3.3): the country list is every ISO 3166-1 alpha-2
// code, labelled via the browser's Intl.DisplayNames, sorted by localized label.
import { describe, expect, it } from 'vitest';

import { buildCountryOptions } from '../../src/features/search/fields/countryOptions';

describe('buildCountryOptions', () => {
  it('returns alpha-2 codes with localized English labels', () => {
    const options = buildCountryOptions('en');
    // A healthy number of countries (the ISO list is ~250).
    expect(options.length).toBeGreaterThan(200);

    const us = options.find((o) => o.code === 'US');
    expect(us).toBeDefined();
    expect(us?.label).toBe('United States');

    // Values are two-letter alpha-2 codes.
    for (const o of options.slice(0, 20)) {
      expect(o.code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('sorts by localized label', () => {
    const options = buildCountryOptions('en');
    const labels = options.map((o) => o.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    expect(labels).toEqual(sorted);
  });
});
