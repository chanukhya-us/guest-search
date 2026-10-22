// Country option list: every ISO 3166-1 alpha-2 code, labelled via the browser's
// internationalization API (Req 3.3).
//
// The value stored in the form is the alpha-2 code (what the shared schema and the
// SOAP mapper expect). Labels come from Intl.DisplayNames (type: 'region'), so they
// are localized by the browser without bundling locale data. i18n-iso-countries
// supplies the canonical code list (getAlpha2Codes needs no registerLocale).
//
// The list is computed once at module load and sorted by localized label using a
// locale-aware collator, so the combobox reads alphabetically in the active language.
import countries from 'i18n-iso-countries';

export interface CountryOption {
  /** ISO 3166-1 alpha-2 code — the value stored in the form and sent to the BFF. */
  code: string;
  /** Localized country name for display (browser Intl, Req 3.3). */
  label: string;
}

/** Build the sorted, localized country list for a given locale (defaults to the UA locale). */
export function buildCountryOptions(locale?: string): CountryOption[] {
  const display = new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'region' });
  const collator = new Intl.Collator(locale ? [locale] : undefined, { sensitivity: 'base' });

  const options = Object.keys(countries.getAlpha2Codes()).map((code) => ({
    code,
    // Fall back to the raw code if the runtime has no display name for it.
    label: safeRegionName(display, code) ?? code,
  }));

  options.sort((a, b) => collator.compare(a.label, b.label));
  return options;
}

/** Intl.DisplayNames.of can throw on an invalid/unknown region; never let it bubble. */
function safeRegionName(display: Intl.DisplayNames, code: string): string | undefined {
  try {
    return display.of(code);
  } catch {
    return undefined;
  }
}
