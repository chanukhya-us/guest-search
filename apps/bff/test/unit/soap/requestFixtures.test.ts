// The request fixtures equal what the real mapper builds for the reference queries
// (task 4.2, Req 25.2, 25.11). File snapshots (`toMatchFileSnapshot`) are added in task 4.3.
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../helpers/c14n.js';
import {
  REFERENCE_REQUESTS,
  buildReference,
  readFixture,
  type ReferenceFixture,
} from '../../helpers/requestFixtures.js';
import { readMappedRequest } from '../../helpers/xmlRead.js';

const names = Object.keys(REFERENCE_REQUESTS) as ReferenceFixture[];

describe.each(names)('%s', (name) => {
  const fixture = readFixture(name);

  it('canonicalizes to the same string as the mapper output', () => {
    expect(canonicalize(fixture, { ignoreFormatting: true })).toBe(
      canonicalize(buildReference(name)),
    );
  });

  it('carries exactly the reference criteria', () => {
    const read = readMappedRequest(fixture);
    const supplied = Object.fromEntries(Object.entries(read).filter(([, v]) => v !== undefined));
    expect(supplied).toEqual(REFERENCE_REQUESTS[name]);
  });

  it('contains synthetic data only', () => {
    const { phone, email, loyaltyMemberId } = readMappedRequest(fixture);
    if (phone !== undefined) expect(phone).toMatch(/^\+1 404 555 01\d\d$/);
    if (email !== undefined) expect(email).toMatch(/@example\.test$/);
    if (loyaltyMemberId !== undefined) expect(loyaltyMemberId).toMatch(/^9000000\d\d$/);
  });
});
