// Pagination tests (task 12.6, Req 17, 24).
//
// These render <ResultsTable> (the owner of page state) directly with synthetic,
// already-masked GuestSummary fixtures, wrapped in a StatusRegionProvider so the
// page-change announcement (Req 17.9) has a live region to write to. They cover:
//   - only the page size (50) of rows renders in <tbody> at a time (Req 17.1);
//   - the range text "Showing X–Y of N guests" reflects the visible slice (Req 17.5);
//   - Next/Previous move between pages and disable at the ends (Req 17.6, 17.7);
//   - numbered buttons expose aria-current="page" on the current page (Req 17.4);
//   - the page <select> jumps directly to a page (Req 17.3);
//   - a page change announces "Page {n} of {pages}" and focuses the caption (Req 17.9);
//   - changing the sort resets to page 1 (Req 17.8 spirit);
//   - at 50 or fewer results the numbered controls are hidden but the range still shows
//     (Req 17.10).
//
// The pure clientPaginator partition property (Req 17.12 / P6) lives with the web
// component suite in task 12.8; here we assert the observable UI behaviour.
import type { GuestSummary, UiConfig } from '@ihg-guest-search/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ResultsTable } from '../../src/features/results/ResultsTable';
import { emptyRevealMap, TestProviders } from '../helpers/providers';

const BANDS: UiConfig['scoreBands'] = { high: 90, medium: 70 };

/** Build N synthetic guests with descending, distinct scores so the default sort is stable. */
function makeGuests(n: number): GuestSummary[] {
  return Array.from({ length: n }, (_unused, i) => {
    // Enterprise ID: "9" + the zero-padded row index, so row i is trivially identifiable
    // ("900000000" for i=0, "900000050" for i=50, "900000100" for i=100).
    const id = `9${String(i).padStart(8, '0')}`;
    // Descending scores keep the default (score desc) order equal to input order, which
    // makes "row at position k" predictable across pages.
    const score = n - i;
    return {
      guest: {
        enterpriseId: id,
        score,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        addresses: [],
        phones: [],
        emails: [],
        memberships: [],
      },
      primary: {},
    } satisfies GuestSummary;
  });
}

function renderTable(results: GuestSummary[]) {
  const onSelect = vi.fn();
  render(
    <TestProviders>
      <ResultsTable
        results={results}
        scoreBands={BANDS}
        canReveal={false}
        reveal={emptyRevealMap()}
        captionId="cap-1"
        onSelect={onSelect}
      />
    </TestProviders>,
  );
  return { onSelect };
}

/** Count the data rows currently rendered in <tbody> (each has an Enterprise ID row header). */
function visibleRowCount(): number {
  return screen.getAllByRole('rowheader').length;
}

describe('Pagination — page slicing (Req 17.1)', () => {
  it('renders only the first 50 rows when there are more than 50 results', () => {
    renderTable(makeGuests(51));
    expect(visibleRowCount()).toBe(50);
  });

  it('renders all rows on a single page when there are 50 or fewer', () => {
    renderTable(makeGuests(49));
    expect(visibleRowCount()).toBe(49);
  });
});

describe('Pagination — range text (Req 17.5)', () => {
  it('shows "Showing 1–50 of 51 guests" on the first page', () => {
    renderTable(makeGuests(51));
    const range = screen.getByTestId('pagination-range');
    expect(range).toHaveTextContent('Showing 1–50 of 51 guests');
  });

  it('shows the final partial range on the last page', () => {
    renderTable(makeGuests(51));
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByTestId('pagination-range')).toHaveTextContent('Showing 51–51 of 51 guests');
  });

  it('uses the singular "guest" for a single result', () => {
    renderTable(makeGuests(1));
    expect(screen.getByTestId('pagination-range')).toHaveTextContent('Showing 1–1 of 1 guest');
  });
});

describe('Pagination — Next/Previous and disabled ends (Req 17.6, 17.7)', () => {
  it('disables Previous on the first page and Next on the last page', () => {
    renderTable(makeGuests(120)); // 3 pages at size 50
    const prev = screen.getByRole('button', { name: /previous page/i });
    const next = screen.getByRole('button', { name: /next page/i });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();

    // Advance to the last page.
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /previous page/i })).toBeEnabled();
  });

  it('moves forward and back between pages, re-slicing the rows', () => {
    renderTable(makeGuests(51));
    // Page 1: First0 visible, First50 not.
    expect(screen.getByRole('rowheader', { name: '900000000' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    // Page 2: only the 51st row (index 50).
    expect(visibleRowCount()).toBe(1);
    expect(screen.getByRole('rowheader', { name: '900000050' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(visibleRowCount()).toBe(50);
  });
});

describe('Pagination — current page indicator (Req 17.4)', () => {
  it('marks the current numbered button with aria-current="page"', () => {
    renderTable(makeGuests(120));
    const pages = screen.getByTestId('pagination-pages');
    const current = within(pages).getByRole('button', { current: 'page' });
    expect(current).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    const current2 = within(screen.getByTestId('pagination-pages')).getByRole('button', {
      current: 'page',
    });
    expect(current2).toHaveTextContent('2');
  });
});

describe('Pagination — page select (Req 17.3)', () => {
  it('jumps to the chosen page via the select control', () => {
    renderTable(makeGuests(120));
    fireEvent.change(screen.getByTestId('pagination-select'), { target: { value: '2' } });
    // Page index 2 => rows 101..120 (20 rows), first is index 100.
    expect(visibleRowCount()).toBe(20);
    expect(screen.getByRole('rowheader', { name: '900000100' })).toBeInTheDocument();
    expect(screen.getByTestId('pagination-range')).toHaveTextContent(
      'Showing 101–120 of 120 guests',
    );
  });
});

describe('Pagination — announcement and focus on page change (Req 17.9)', () => {
  it('announces "Page {n} of {pages}" and focuses the caption', async () => {
    renderTable(makeGuests(120));
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    // The caption is the focus target on a page change (synchronous with the effect).
    expect(document.activeElement?.tagName).toBe('CAPTION');
    // The StatusRegion debounces then clears/sets, so the text appears asynchronously.
    const region = screen.getByRole('status');
    await screen.findByText('Page 2 of 3');
    expect(region).toHaveTextContent('Page 2 of 3');
  });
});

describe('Pagination — sort resets to page 1 (Req 17.8)', () => {
  it('returns to page 1 when the sort column changes', () => {
    renderTable(makeGuests(120));
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByTestId('pagination-range')).toHaveTextContent('Showing 51–100');

    // Change the sort: should snap back to page 1.
    fireEvent.click(screen.getByRole('button', { name: /last name/i }));
    expect(screen.getByTestId('pagination-range')).toHaveTextContent('Showing 1–50');
    const current = within(screen.getByTestId('pagination-pages')).getByRole('button', {
      current: 'page',
    });
    expect(current).toHaveTextContent('1');
  });
});

describe('Pagination — control visibility at the boundary (Req 17.10)', () => {
  it('hides the numbered controls but shows the range at exactly 50 results', () => {
    renderTable(makeGuests(50));
    expect(screen.getByTestId('pagination-range')).toHaveTextContent('Showing 1–50 of 50 guests');
    // No Prev/Next/numbered buttons on a single page.
    expect(screen.queryByTestId('pagination-pages')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
  });

  it('shows the numbered controls at 51 results (two pages)', () => {
    renderTable(makeGuests(51));
    expect(screen.getByTestId('pagination-pages')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next page/i })).toBeInTheDocument();
  });

  it('shows the range even for an empty result set', () => {
    renderTable([]);
    expect(screen.getByTestId('pagination-range')).toHaveTextContent('Showing 0–0 of 0 guests');
    expect(screen.queryByTestId('pagination-pages')).not.toBeInTheDocument();
  });
});
