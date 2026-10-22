// Unit tests for the SOAP contract module (task 3.1, Req 7.1-7.5). Request placements come
// from the team's sample request (docs/Request.txt).
// The src/** literal scan (Req 7.6) is task 3.4.
import { describe, expect, it } from 'vitest';
import {
  ALLOW,
  DEFAULTS,
  EL,
  HEADER_CREDENTIAL_LOCATION,
  NS,
  ORDER,
  PREFIX,
  SAMPLE_SOURCE,
  SUCCESS,
  nsUri,
  qname,
  type ElKey,
} from '../../../src/soap/contract.js';

describe('soap contract', () => {
  it('defines exactly the six namespace URIs from Req 7.1', () => {
    expect(Object.values(NS).sort()).toEqual(
      [
        'http://schemas.xmlsoap.org/soap/envelope/',
        'http://atp.ihg.com/schema/common/ATPCommonServiceTypes/v1',
        'http://crm.ihg.com/schema/v1_0/initiate',
        'http://common.crm.ihg.com/schema/v1_0/complex',
        'http://atp.ihg.com/schema/crs/initiate/servicetypes/v1',
        'http://common.crm.ihg.com/schema/v1_0/basictypes',
      ].sort(),
    );
  });

  it('gives every namespace a distinct prefix alias', () => {
    expect(Object.keys(PREFIX).sort()).toEqual(Object.keys(NS).sort());
    expect(new Set(Object.values(PREFIX)).size).toBe(Object.keys(NS).length);
  });

  it('places every element in a known namespace (or none); verified entries cite a source', () => {
    for (const e of Object.values(EL)) {
      if (e.ns !== null) expect(Object.keys(NS)).toContain(e.ns);
      expect(e.local).toMatch(/^[A-Za-z][\w-]*$/);
      if (e.verified) expect(e.xsd).toBe(SAMPLE_SOURCE);
      else expect(e.xsd).toBeUndefined();
    }
  });

  it('marks exactly the elements of the team sample request as verified', () => {
    const verified = (Object.keys(EL) as ElKey[]).filter((k) => EL[k].verified).sort();
    expect(verified).toEqual(
      [
        'envelope',
        'body',
        'searchGuestRequest',
        'header',
        'headerLanguage',
        'headerChannel',
        'headerSubChannel',
        'headerVersion',
        'headerEnvironment',
        'headerUser',
        'headerTransactionId',
        'headerTransactionSequence',
        'headerSendTimeStamp',
        'searchCriteria',
        'name',
        'given',
        'surname',
        'phone',
        'email',
        'emailAddress',
        'address',
        'source',
        'region1',
        'country',
        'membership',
        'allAttributes',
        'allHistory',
        'maxResults',
      ].sort(),
    );
    // Not in the sample: inferred placement only.
    for (const k of ['line1', 'locality1', 'postalCode'] as const) {
      expect(EL[k]).toMatchObject({ ns: 'complex', verified: false });
    }
  });

  it('places the request criteria as in the sample: groups in initiate, children in complex', () => {
    const where = (keys: readonly ElKey[]) => keys.map((k) => EL[k].ns);
    const groups = ['name', 'phone', 'email', 'emailAddress', 'address', 'membership'] as const;
    const parts = ['given', 'surname', 'source', 'region1', 'country'] as const;
    expect(where(groups)).toEqual(groups.map(() => 'initiate'));
    expect(where(parts)).toEqual(parts.map(() => 'complex'));
    expect(EL.header.ns).toBe('common');
    expect(ORDER.searchGuestRequest[0]).toBe('header');
  });

  it('mirrors the request placement for the unverified response identities', () => {
    const pairs: [ElKey, ElKey][] = [
      ['guestName', 'name'],
      ['guestGiven', 'given'],
      ['guestSurname', 'surname'],
      ['guestAddress', 'address'],
      ['guestAddressSource', 'source'],
      ['guestLine1', 'line1'],
      ['guestLocality1', 'locality1'],
      ['guestRegion1', 'region1'],
      ['guestPostalCode', 'postalCode'],
      ['guestCountry', 'country'],
      ['guestPhone', 'phone'],
      ['guestEmail', 'email'],
      ['guestEmailAddress', 'emailAddress'],
      ['guestMembership', 'membership'],
    ];
    for (const [guest, request] of pairs) {
      expect(EL[guest]).toEqual({ ns: EL[request].ns, local: EL[request].local, verified: false });
    }
  });

  it('covers the elements the mapper and parser need', () => {
    expect(EL.envelope).toMatchObject({ ns: 'soap', local: 'Envelope' });
    expect(EL.body).toMatchObject({ ns: 'soap', local: 'Body' });
    expect(EL.fault).toMatchObject({ ns: 'soap', local: 'Fault' });
    expect(EL.transactionStatus.local).toBe('transactionStatus');
    for (const local of ALLOW.childElements) {
      expect(Object.values(EL).some((e) => e.local === local)).toBe(true);
    }
  });

  it('resolves namespace URIs, with null for unqualified elements', () => {
    expect(nsUri(EL.envelope)).toBe(NS.soap);
    expect(nsUri(EL.searchGuestRequest)).toBe(NS.svc);
    expect(nsUri(EL.faultcode)).toBeNull();
  });

  it('builds qualified names from the prefix table', () => {
    expect(qname(EL.envelope)).toBe('soap:Envelope');
    expect(qname(EL.header)).toBe('header'); // common is the default namespace
    expect(qname(EL.faultcode)).toBe('faultcode');
  });

  it('defines no credential location until B5/B6', () => {
    expect(HEADER_CREDENTIAL_LOCATION).toBeNull();
  });

  it('orders children using EL keys only', () => {
    for (const keys of Object.values(ORDER)) {
      for (const k of keys) expect(Object.keys(EL)).toContain(k);
    }
    expect(ORDER.searchCriteria).toEqual(['name', 'phone', 'email', 'address', 'membership']);
  });

  it('matches the request defaults of Req 7.2', () => {
    expect(DEFAULTS).toEqual({
      criteriaStatus: 'O',
      phoneLocation: 'H',
      phoneProfileDefault: 'true',
      emailProfileDefault: 'true',
      addressLocationCode: 'H',
      addressProfileDefault: 'true',
      allAttributes: 'true',
      allHistory: 'false',
      headerVersionMajor: '1',
      headerVersionMinor: '0',
    });
  });

  it('matches the success indicators of Req 7.3', () => {
    expect(SUCCESS).toEqual({ transactionSuccessful: 'true', overallStatusCode: '0000' });
  });

  it('never allowlists card data (Req 12.10)', () => {
    const allowed = Object.values(ALLOW).flat();
    expect(allowed).not.toContain('creditCard');
    expect(allowed).not.toContain('token');
  });
});
