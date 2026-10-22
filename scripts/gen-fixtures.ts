/**
 * Generates apps/bff/test/fixtures/soap/response-60-guests.xml from
 * scripts/templates/response-60-guests.template.xml (task 5.2, design.md "Fixtures").
 *
 *   npm run gen:fixtures
 *
 * Runs on Node 22.6+ via `--experimental-strip-types` (on by default from Node 23.6), so it
 * uses erasable TypeScript only and imports nothing but Node built-ins. Namespace URIs live
 * in the template, never here. The output is deterministic: no clock, no randomness, LF only.
 * scripts/gen-fixtures.test.ts fails if the committed file drifts from `render60Guests()`.
 *
 * Template syntax: the single `{{#guest}}...{{/guest}}` block (own lines) is repeated once
 * per guest with `{{nn}}` (01..60) and `{{score}}` substituted. Anything else is copied.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GUEST_COUNT = 60;

export const TEMPLATE_URL = new URL('./templates/response-60-guests.template.xml', import.meta.url);
export const OUTPUT_URL = new URL(
  '../apps/bff/test/fixtures/soap/response-60-guests.xml',
  import.meta.url,
);

const BLOCK = /^\{\{#guest\}\}\n([\s\S]*?)^\{\{\/guest\}\}\n/m;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Values for guest `i` (1-based). Two digits keep IDs in 9000000xx and phones in 555 01xx. */
function guestValues(i: number): Record<string, string> {
  return {
    nn: String(i).padStart(2, '0'),
    // Distinct, descending scores so sort order is unambiguous: 99.5, 99.0, ... 70.0.
    score: (100 - i * 0.5).toFixed(1),
  };
}

/** Render the template with `count` guests (1..99). Pure: a function of its inputs only. */
export function renderGuestList(template: string, count: number = GUEST_COUNT): string {
  if (!Number.isInteger(count) || count < 1 || count > 99) {
    throw new RangeError('count must be an integer from 1 to 99');
  }
  const lf = template.replace(/\r\n?/g, '\n');
  const match = BLOCK.exec(lf);
  if (match === null) throw new Error('template has no {{#guest}}...{{/guest}} block');
  const body = match[1] ?? '';

  const guests = Array.from({ length: count }, (_, k) => {
    const values = guestValues(k + 1);
    return body.replace(PLACEHOLDER, (whole, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error('unknown placeholder ' + whole);
      return value;
    });
  }).join('');

  const out = lf.slice(0, match.index) + guests + lf.slice(match.index + match[0].length);
  if (out.includes('{{')) throw new Error('placeholder outside the {{#guest}} block');
  return out;
}

/** The exact content of the committed response-60-guests.xml. */
export const render60Guests = (): string =>
  renderGuestList(readFileSync(TEMPLATE_URL, 'utf8'), GUEST_COUNT);

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  writeFileSync(OUTPUT_URL, render60Guests(), 'utf8');
  console.log('wrote ' + fileURLToPath(OUTPUT_URL));
}
