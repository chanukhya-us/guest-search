// Response fixture table (task 5.2, Req 2.2, 25.3, 25.11): every fixture parses to the
// expected outcome, every file in the folder is accounted for, and only synthetic data is
// used. Detailed field assertions are in responseParser.fixtures.test.ts (task 5.3).
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SoapError, parseSearchGuestResponse } from '../../../src/soap/responseParser.js';
import { FIXTURE_DIR, readFixture } from '../../helpers/requestFixtures.js';
import {
  CC_TOKEN_FIXTURE_PII,
  CC_TOKEN_MARKER,
  RESPONSE_FIXTURES,
  type FixtureOutcome,
} from '../../helpers/responseFixtures.js';

const table = Object.entries(RESPONSE_FIXTURES) as [string, FixtureOutcome][];
const allFiles = readdirSync(FIXTURE_DIR).filter((f) => /\.(xml|html)$/.test(f));

describe('response fixtures', () => {
  it('the table covers every non-request fixture in the folder', () => {
    // request-*.xml are mapper outputs; sample-request-*.xml is the team's sample request.
    const responses = allFiles.filter((f) => !/^(?:sample-)?request-/.test(f)).sort();
    expect(responses).toEqual(Object.keys(RESPONSE_FIXTURES).sort());
  });

  it.each(table)('%s', (file, outcome) => {
    const xml = readFixture(file);
    if ('guests' in outcome) {
      expect(parseSearchGuestResponse(xml)).toHaveLength(outcome.guests);
      return;
    }
    let caught: unknown;
    try {
      parseSearchGuestResponse(xml);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SoapError);
    expect(caught).toMatchObject({ code: outcome.error });
    if (outcome.detail !== undefined) expect(caught).toMatchObject({ detail: outcome.detail });
  });

  it('prefix variants carry exactly the data of response-multiple.xml', () => {
    const expected = parseSearchGuestResponse(readFixture('response-multiple.xml'));
    for (const f of ['response-odd-prefixes.xml', 'response-default-namespace.xml']) {
      expect(parseSearchGuestResponse(readFixture(f))).toStrictEqual(expected);
    }
  });

  it('response-with-cc-token.xml contains the exported markers', () => {
    const xml = readFixture('response-with-cc-token.xml');
    expect(xml.split(CC_TOKEN_MARKER)).toHaveLength(3); // element text and attribute
    for (const v of Object.values(CC_TOKEN_FIXTURE_PII)) expect(xml).toContain(v);
    // The marker is unique to this fixture, so a hit in a log can only come from it.
    for (const f of allFiles.filter((n) => n !== 'response-with-cc-token.xml')) {
      expect(readFixture(f)).not.toContain(CC_TOKEN_MARKER);
    }
  });

  it.each(allFiles)('%s uses synthetic data only (Req 25.11)', (file) => {
    const xml = readFixture(file);
    for (const email of xml.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
      expect(email).toMatch(/@example\.test$/);
    }
    for (const phone of xml.match(/\+\d[\d ]{6,}\d/g) ?? []) {
      expect(phone).toMatch(/^\+1 404 555 01\d\d$/);
    }
    for (const id of xml.match(/(?<![\w-])\d{9}(?![\w-])/g) ?? []) {
      expect(id).toMatch(/^9000000\d\d$/);
    }
    expect(xml).not.toContain('\uFFFD');
  });
});
