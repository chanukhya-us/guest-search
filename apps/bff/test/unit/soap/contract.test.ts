// Unit tests for the SOAP contract module (task 3.1, Req 7.1-7.5).
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
  SUCCESS,
  nsUri,
  qname,
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

  it('places every element in a known namespace (or none) and marks it unverified', () => {
    for (const e of Object.values(EL)) {
      if (e.ns !== null) expect(Object.keys(NS)).toContain(e.ns);
      expect(e.local).toMatch(/^[A-Za-z][\w-]*$/);
      expect(e.verified).toBe(false);
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
