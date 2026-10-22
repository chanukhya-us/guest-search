// Unit tests for the namespace-aware test XML reader (task 4.2, Req 25.2).
import { describe, expect, it } from 'vitest';
import { EL, NS } from '../../../src/soap/contract.js';
import { buildSearchGuestRequest } from '../../../src/soap/requestMapper.js';
import { REFERENCE_HEADER } from '../../helpers/requestFixtures.js';
import {
  attr,
  descendants,
  find,
  findAll,
  has,
  parseXml,
  readMappedRequest,
  select,
  text,
} from '../../helpers/xmlRead.js';

const ALL_ON = { maxResults: 50, features: { addressLine1: true, city: true, postalCode: true } };

describe('parseXml', () => {
  it('throws on malformed XML and on a DOCTYPE', () => {
    expect(() => parseXml('<r><a></r>')).toThrow();
    expect(() => parseXml('not xml')).toThrow();
    expect(() => parseXml('<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>')).toThrow();
  });
});

describe('element lookup by namespace URI + local name', () => {
  // Unfamiliar prefixes and the default namespace: lookups must not depend on prefixes.
  const doc = parseXml(
    `<e:Envelope xmlns:e="${NS.soap}"><e:Body><searchGuestRequest xmlns="${NS.svc}">` +
      `<searchCriteria status="O"><x:phone xmlns:x="${NS.complex}" number="1"/>` +
      `<x:phone xmlns:x="${NS.complex}" number="2"/><phone number="wrong-ns"/>` +
      `</searchCriteria></searchGuestRequest></e:Body></e:Envelope>`,
  );
  const crit = [EL.envelope, EL.body, EL.searchGuestRequest, EL.searchCriteria];

  it('find, findAll, has, text and attr', () => {
    expect(attr(find(doc, crit), 'status')).toBe('O');
    expect(findAll(doc, [...crit, EL.phone]).map((p) => attr(p, 'number'))).toEqual(['1', '2']);
    expect(has(doc, [...crit, EL.phone])).toBe(true);
    expect(has(doc, [...crit, EL.email])).toBe(false);
    expect(find(doc, [...crit, EL.email])).toBeUndefined();
    expect(text(undefined)).toBeUndefined();
    expect(attr(find(doc, crit), 'missing')).toBeUndefined();
    expect(descendants(doc, EL.phone)).toHaveLength(2);
  });

  it('select uses NS keys as XPath prefixes', () => {
    expect(select(doc, '//svc:searchCriteria/complex:phone/@number')).toHaveLength(2);
    expect(() => select(doc, 'count(//complex:phone)')).toThrow();
  });
});

describe('readMappedRequest', () => {
  it('reads every mapped field back from a full envelope', () => {
    const q = {
      firstName: 'Ann & <Bo>',
      lastName: 'Testguest',
      phone: '+1 404 555 0102',
      email: 'guest02@example.test',
      stateOrRegion: 'GA',
      country: 'US',
      addressLine1: '1 Test St',
      city: 'Atlanta',
      postalCode: '30301',
      memberType: 'PLACEHOLDER',
      loyaltyMemberId: '900000012',
    };
    expect(readMappedRequest(buildSearchGuestRequest(q, REFERENCE_HEADER, ALL_ON))).toEqual(q);
  });

  it('reads absent groups as undefined', () => {
    const read = readMappedRequest(
      buildSearchGuestRequest({ lastName: 'Testguest' }, REFERENCE_HEADER, ALL_ON),
    );
    expect(read.lastName).toBe('Testguest');
    expect(Object.values(read).filter((v) => v !== undefined)).toEqual(['Testguest']);
  });

  it('throws when searchCriteria is missing or a field repeats', () => {
    expect(() => readMappedRequest(`<s:Envelope xmlns:s="${NS.soap}"/>`)).toThrow();
    const twoNames =
      `<s:Envelope xmlns:s="${NS.soap}"><s:Body><v:searchGuestRequest xmlns:v="${NS.svc}">` +
      `<v:searchCriteria><n:name xmlns:n="${NS.complex}"/><n:name xmlns:n="${NS.complex}"/>` +
      `<n:phone xmlns:n="${NS.complex}" number="1"/><n:phone xmlns:n="${NS.complex}" number="2"/>` +
      `</v:searchCriteria></v:searchGuestRequest></s:Body></s:Envelope>`;
    expect(() => readMappedRequest(twoNames)).toThrow(/phone/);
  });
});
