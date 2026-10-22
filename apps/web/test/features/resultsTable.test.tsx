// Results table tests (task 12.5, Req 15, 13, 14, 23, 24).
//
// These render <ResultsTable> directly with synthetic, already-masked GuestSummary
// fixtures (no network). They cover:
//   - the 14 column headers in the Req 15.1 order, plus the actions column;
//   - one row per GuestSummary, with primaries populated from the BFF-selected values;
//   - masked phone/email shown verbatim, with no unmasked value anywhere in the DOM;
//   - score band labels reflecting the configurable thresholds, conveyed in TEXT not
//     colour alone, and missing scores rendering the empty indicator;
//   - absent primary fields rendering the "Not provided" empty indicator;
//   - "View details" calling onSelect with the right summary (seam for the 12.7 drawer);
//   - the accessible table semantics: a <caption> stating the count, <th scope="col">
//     headers, Enterprise ID as <th scope="row">, and a labelled focusable scroll region;
//   - sorting: default score-desc order, a sortable header exposing aria-sort, and
//     clicking a text header re-ordering the rows.
import type { GuestSummary, UiConfig } from '@ihg-guest-search/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ResultsTable } from '../../src/features/results/ResultsTable';
import { emptyRevealMap, TestProviders } from '../helpers/providers';

const BANDS: UiConfig['scoreBands'] = { high: 90, medium: 70 };

/** Build a synthetic GuestSummary. Contact values are pre-masked, as the BFF returns. */
function summary(overrides: {
  enterpriseId: string;
  score?: number;
  firstName?: string;
  lastName?: string;
  city?: string;
  country?: string;
  stateOrRegion?: string;
  postalCode?: string;
  line1?: string;
  phoneMasked?: string;
  emailMasked?: string;
  memberId?: string;
  memberType?: string;
  membershipStatus?: string;
}): GuestSummary {
  const {
    enterpriseId,
    score,
    firstName,
    lastName,
    city,
    country,
    stateOrRegion,
    postalCode,
    line1,
    phoneMasked,
    emailMasked,
    memberId,
    memberType,
    membershipStatus,
  } = overrides;
  const address =
    line1 || city || stateOrRegion || postalCode || country
      ? { line1, city, stateOrRegion, postalCode, country, profileDefault: true }
      : undefined;
  const phone = phoneMasked ? { number: phoneMasked, profileDefault: true } : undefined;
  const email = emailMasked ? { address: emailMasked, profileDefault: true } : undefined;
  const membership =
    memberId || memberType || membershipStatus
      ? { memberId, memberType, status: membershipStatus }
      : undefined;
  return {
    guest: {
      enterpriseId,
      score,
      firstName,
      lastName,
      addresses: address ? [address] : [],
      phones: phone ? [phone] : [],
      emails: email ? [email] : [],
      memberships: membership ? [membership] : [],
    },
    primary: { address, phone, email, membership },
  };
}

const ALEX = summary({
  enterpriseId: '900000001',
  score: 97,
  firstName: 'Alex',
  lastName: 'Testperson',
  line1: '1 Example St',
  city: 'Atlanta',
  stateOrRegion: 'GA',
  postalCode: '30301',
  country: 'US',
  phoneMasked: '•••• 0101',
  emailMasked: 'a•••@example.test',
  memberId: '900000101',
  memberType: 'PC',
  membershipStatus: 'A',
});

const BLAIR = summary({
  enterpriseId: '900000002',
  score: 72,
  firstName: 'Blair',
  lastName: 'Example',
  city: 'Denver',
  country: 'US',
  phoneMasked: '•••• 0202',
  emailMasked: 'b•••@example.test',
});

const CASEY = summary({
  enterpriseId: '900000003',
  // no score: should sort last and show the empty indicator in the score cell
  firstName: 'Casey',
  lastName: 'Zephyr',
});

function renderTable(results: GuestSummary[], onSelect = vi.fn(), canReveal = false) {
  // ResultsTable announces page changes via the StatusRegion and uses a reveal mutation
  // (task 12.6/12.7), so it must render inside the QueryClient + StatusRegion providers
  // the app shell always mounts.
  render(
    <TestProviders>
      <ResultsTable
        results={results}
        scoreBands={BANDS}
        canReveal={canReveal}
        reveal={emptyRevealMap()}
        captionId="cap-1"
        onSelect={onSelect}
      />
    </TestProviders>,
  );
  return { onSelect };
}

describe('ResultsTable — columns and content (Req 15.1, 15.2, 13)', () => {
  it('renders the 14 column headers in order (Req 15.1)', () => {
    renderTable([ALEX]);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim() ?? '');
    // The 14 data columns in order, then the (visually hidden) Details actions header.
    expect(headers).toEqual([
      expect.stringContaining('Match score'),
      'Enterprise ID',
      expect.stringContaining('First name'),
      expect.stringContaining('Last name'),
      'Address',
      expect.stringContaining('City'),
      'State or region',
      'Postal code',
      expect.stringContaining('Country'),
      'Phone',
      'Email',
      'Loyalty member ID',
      'Member type',
      'Membership status',
      'Details',
    ]);
  });

  it('renders one row per guest with primaries populated from the BFF values (Req 15.2)', () => {
    renderTable([ALEX, BLAIR]);
    // Two data rows (header row is in <thead>, excluded from tbody row queries via text).
    expect(screen.getByText('1 Example St')).toBeInTheDocument();
    expect(screen.getByText('Atlanta')).toBeInTheDocument();
    expect(screen.getByText('GA')).toBeInTheDocument();
    expect(screen.getByText('30301')).toBeInTheDocument();
    expect(screen.getByText('900000101')).toBeInTheDocument(); // member ID
    expect(screen.getByText('PC')).toBeInTheDocument(); // member type
    // Enterprise ID is a row header, not a plain cell.
    expect(screen.getByRole('rowheader', { name: '900000001' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '900000002' })).toBeInTheDocument();
  });

  it('shows the masked phone/email verbatim and never any unmasked value (Req 14.12)', () => {
    renderTable([ALEX]);
    expect(screen.getByText('•••• 0101')).toBeInTheDocument();
    expect(screen.getByText('a•••@example.test')).toBeInTheDocument();
    // No unmasked form of the synthetic contact appears anywhere in the DOM: the local
    // part is masked to a single leading character, so the full address never renders.
    expect(document.body.textContent).not.toMatch(/alex@example\.test/i);
    // The phone mask replaces the leading digits with bullets; the component renders the
    // masked string exactly and never reconstructs the unmasked number.
    expect(document.body.textContent).toContain('•••• 0101');
  });
});

describe('ResultsTable — score band (Req 15.6, 24.5)', () => {
  it('labels the band in text per the thresholds and not by colour alone', () => {
    renderTable([ALEX, BLAIR, CASEY]);
    // 97 >= 90 -> High; 72 in [70,90) -> Medium; no score -> no chip.
    const high = screen.getByText(/High match/i);
    const medium = screen.getByText(/Medium match/i);
    expect(high).toBeInTheDocument();
    expect(medium).toBeInTheDocument();
    // The band is text (not colour-only): the chips carry the readable label.
    const chips = screen.getAllByTestId('score-band');
    expect(chips).toHaveLength(2); // only the two scored rows
    expect(chips.map((c) => c.getAttribute('data-band'))).toEqual(['high', 'medium']);
  });

  it('applies the configurable thresholds (boundary at exactly the band value)', () => {
    const onBoundary = summary({ enterpriseId: '900000010', score: 90, firstName: 'Edge' });
    renderTable([onBoundary]);
    // 90 >= high(90) -> High.
    expect(screen.getByTestId('score-band').getAttribute('data-band')).toBe('high');
  });

  it('renders the empty indicator for a missing score and no chip (Req 12.8, 15.6)', () => {
    renderTable([CASEY]);
    // Casey has no score: no band chip, and the score cell shows "Not provided".
    expect(screen.queryByTestId('score-band')).not.toBeInTheDocument();
    expect(screen.getAllByText('Not provided').length).toBeGreaterThan(0);
  });
});

describe('ResultsTable — empty fields (Req 15.2)', () => {
  it('renders the "Not provided" indicator for absent primaries', () => {
    renderTable([CASEY]);
    // Casey has no address/phone/email/membership: those cells show the empty indicator.
    const notProvided = screen.getAllByText('Not provided');
    // score + address(5) + phone + email + memberId + memberType + status = 10 empties.
    expect(notProvided.length).toBeGreaterThanOrEqual(9);
  });
});

describe('ResultsTable — details affordance (Req 16.1)', () => {
  it('calls onSelect with the correct summary when View details is activated', () => {
    const { onSelect } = renderTable([ALEX, BLAIR]);
    const btn = screen.getByRole('button', { name: /view details for alex testperson/i });
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ALEX);
  });

  it('exposes a View details button per row with the guest name in its accessible name', () => {
    renderTable([ALEX, BLAIR]);
    expect(
      screen.getByRole('button', { name: /view details for alex testperson/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /view details for blair example/i }),
    ).toBeInTheDocument();
  });
});

describe('ResultsTable — accessible semantics (Req 15.3, 15.8, 24)', () => {
  it('has a caption stating the result count', () => {
    renderTable([ALEX, BLAIR]);
    const table = screen.getByRole('table');
    expect(table).toHaveAccessibleName(/2 guests/i);
  });

  it('places the table in a labelled, keyboard-focusable scroll region (Req 15.8)', () => {
    renderTable([ALEX]);
    const region = screen.getByRole('region', { name: /search results: 1 guest/i });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('uses th scope="col" for headers and th scope="row" for Enterprise ID', () => {
    renderTable([ALEX]);
    const colHeaders = screen.getAllByRole('columnheader');
    expect(colHeaders.length).toBe(15); // 14 data columns + actions
    const rowHeader = screen.getByRole('rowheader', { name: '900000001' });
    expect(rowHeader.tagName).toBe('TH');
    expect(rowHeader).toHaveAttribute('scope', 'row');
  });
});

describe('ResultsTable — sorting (Req 15.5, 15.7)', () => {
  it('defaults to Match Score descending, with unscored guests last (Req 15.5)', () => {
    renderTable([BLAIR, CASEY, ALEX]); // deliberately unsorted input
    const rowHeaders = screen.getAllByRole('rowheader').map((h) => h.textContent);
    // Alex(97) > Blair(72) > Casey(none).
    expect(rowHeaders).toEqual(['900000001', '900000002', '900000003']);
  });

  it('exposes aria-sort on the sorted Match score column by default', () => {
    renderTable([ALEX, BLAIR]);
    const scoreHeader = screen.getByRole('columnheader', { name: /match score/i });
    expect(scoreHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts by a text column when its header button is activated (Req 15.7)', () => {
    renderTable([ALEX, BLAIR, CASEY]);
    // Activate Last name sorting. The first toggle is ascending: Example, Testperson,
    // Zephyr. aria-sort moves to the active column and the previous sort is replaced.
    fireEvent.click(screen.getByRole('button', { name: /last name/i }));
    const lastHeader = screen.getByRole('columnheader', { name: /last name/i });
    expect(lastHeader).toHaveAttribute('aria-sort', 'ascending');
    const rowHeadersAsc = screen.getAllByRole('rowheader').map((h) => h.textContent);
    // Example(2), Testperson(1), Zephyr(3).
    expect(rowHeadersAsc).toEqual(['900000002', '900000001', '900000003']);
    // Match score is no longer the active sort column.
    expect(screen.getByRole('columnheader', { name: /match score/i })).toHaveAttribute(
      'aria-sort',
      'none',
    );

    // A second activation flips to descending: Zephyr, Testperson, Example.
    fireEvent.click(screen.getByRole('button', { name: /last name/i }));
    expect(lastHeader).toHaveAttribute('aria-sort', 'descending');
    const rowHeadersDesc = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(rowHeadersDesc).toEqual(['900000003', '900000001', '900000002']);
  });
});
