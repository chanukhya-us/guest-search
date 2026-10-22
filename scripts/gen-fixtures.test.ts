// Drift guard for the generated fixture (task 5.2): the committed response-60-guests.xml must
// equal the generator output byte for byte. Fix a failure with `npm run gen:fixtures`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUEST_COUNT, OUTPUT_URL, render60Guests, renderGuestList } from './gen-fixtures.js';

describe('gen-fixtures', () => {
  it('committed response-60-guests.xml equals the generator output', () => {
    expect(readFileSync(OUTPUT_URL, 'utf8')).toBe(render60Guests());
  });

  it('is deterministic and renders one guest block per index', () => {
    const out = render60Guests();
    expect(render60Guests()).toBe(out);
    expect(out.match(/<ns2:initiateGuest /g)).toHaveLength(GUEST_COUNT);
    expect(out).toContain('<ns2:enterpriseId>900000001</ns2:enterpriseId>');
    expect(out).toContain('<ns2:enterpriseId>900000060</ns2:enterpriseId>');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('\r');
  });

  it('rejects templates it cannot render', () => {
    const block = '{{#guest}}\n<g>{{nn}}</g>\n{{/guest}}\n';
    expect(renderGuestList('<r>\n' + block + '</r>\n', 2)).toBe(
      '<r>\n<g>01</g>\n<g>02</g>\n</r>\n',
    );
    expect(() => renderGuestList('<r/>', 1)).toThrow(/no \{\{#guest\}\}/);
    expect(() => renderGuestList('{{#guest}}\n{{nope}}\n{{/guest}}\n', 1)).toThrow(/unknown/);
    expect(() => renderGuestList('{{x}}\n' + block, 1)).toThrow(/outside/);
    expect(() => renderGuestList(block, 100)).toThrow(RangeError);
  });
});
