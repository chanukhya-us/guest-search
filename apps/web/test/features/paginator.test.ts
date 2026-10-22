// Paginator tests (task 12.8, Req 17, 25.4).
//
// The pure paging math lives in src/features/results/usePaginator.ts. The pagination
// *component* behaviour (control states, range text, focus/announce) is covered by
// features/pagination.test.tsx; this file proves the pure function underneath it:
//   - P6 (pagination partition, design.md "Correctness Properties"): concatenating the
//     page ranges from clientPaginator reproduces indices 0..total-1 in order, each
//     exactly once, and pageCount === ceil(total / pageSize);
//   - the clamping and view-model edge cases the property's generators don't pin down
//     (page size <= 0, out-of-range pageIndex, the empty set reading "Page 1 of 1").
import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';

import {
  clientPaginator,
  DEFAULT_PAGE_SIZE,
  pageRange,
  paginatorView,
} from '../../src/features/results/usePaginator';

/** >= 100 runs as required for the web property (design.md: fast-check properties). */
const NUM_RUNS = 300;

/**
 * Walk every page of a geometry and collect the concatenation of its half-open ranges.
 * Returns the flattened index list so the test can assert it equals [0, total).
 */
function concatPages(total: number, pageSize: number): number[] {
  const geo = clientPaginator(total, pageSize);
  const indices: number[] = [];
  for (const i of geo.pageIndexes) {
    const { start, end } = pageRange(geo, i);
    for (let k = start; k < end; k += 1) indices.push(k);
  }
  return indices;
}

describe('clientPaginator — P6 pagination partition (Req 17.12)', () => {
  // Feature: ihg-guest-search, Property 6: Pagination partition — for all total in
  // [0, 1000], concatenating the pages from clientPaginator(total, 50) reproduces indices
  // 0..total-1 in order, each exactly once, and pageCount === Math.ceil(total / 50).
  // **Validates: Requirements 17.12, 25.4**
  test.prop([fc.integer({ min: 0, max: 1000 })], { numRuns: NUM_RUNS })(
    'P6: pages tile [0, total) exactly at the default page size of 50',
    (total) => {
      const geo = clientPaginator(total, DEFAULT_PAGE_SIZE);
      // pageCount is exactly ceil(total / 50) (and 0 at total 0: ceil(0/50) === 0).
      expect(geo.pageCount).toBe(Math.ceil(total / DEFAULT_PAGE_SIZE));

      const concatenated = concatPages(total, DEFAULT_PAGE_SIZE);
      // Every index appears exactly once, in order: the concat equals [0 .. total-1].
      expect(concatenated).toEqual(Array.from({ length: total }, (_u, i) => i));
    },
  );

  // Feature: ihg-guest-search, Property 6 (generalised page size): the partition holds for
  // any page size > 0, with each page of size P except the last (which holds 1..P), and
  // pageCount === ceil(total / P).
  // **Validates: Requirements 17.12, 25.4**
  test.prop([fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 200 })], {
    numRuns: NUM_RUNS,
  })('P6: the partition holds for an arbitrary positive page size', (total, pageSize) => {
    const geo = clientPaginator(total, pageSize);
    expect(geo.pageCount).toBe(total <= 0 ? 0 : Math.ceil(total / pageSize));

    // The concatenation is a clean 0..total-1 cover.
    const concatenated = concatPages(total, pageSize);
    expect(concatenated).toEqual(Array.from({ length: total }, (_u, i) => i));

    // Each page is full (size P) except the last, which carries 1..P rows.
    geo.pageIndexes.forEach((i) => {
      const { start, end } = pageRange(geo, i);
      const size = end - start;
      if (i < geo.pageCount - 1) {
        expect(size).toBe(pageSize);
      } else {
        expect(size).toBeGreaterThanOrEqual(1);
        expect(size).toBeLessThanOrEqual(pageSize);
      }
    });
  });
});

describe('clientPaginator — clamping and defaults', () => {
  it('defaults to a page size of 50', () => {
    expect(clientPaginator(120).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(clientPaginator(120).pageCount).toBe(3);
  });

  it('reports a single empty page geometry for an empty set', () => {
    const geo = clientPaginator(0, 50);
    expect(geo.pageCount).toBe(0);
    expect(geo.pageIndexes).toEqual([]);
    expect(geo.total).toBe(0);
  });

  it('clamps a non-positive page size up to 1 so it never divides by zero', () => {
    expect(clientPaginator(5, 0).pageSize).toBe(1);
    expect(clientPaginator(5, 0).pageCount).toBe(5);
    expect(clientPaginator(5, -10).pageSize).toBe(1);
  });

  it('floors a fractional page size and treats negative totals as zero', () => {
    expect(clientPaginator(10, 3.9).pageSize).toBe(3);
    expect(clientPaginator(-4, 50).total).toBe(0);
    expect(clientPaginator(-4, 50).pageCount).toBe(0);
  });
});

describe('pageRange — out-of-range pages', () => {
  it('returns an empty range for a negative or overflowing page index', () => {
    const geo = clientPaginator(60, 50); // 2 pages: [0,50) and [50,60)
    expect(pageRange(geo, -1)).toEqual({ start: 0, end: 0 });
    expect(pageRange(geo, 2)).toEqual({ start: 0, end: 0 });
    expect(pageRange(geo, 0)).toEqual({ start: 0, end: 50 });
    expect(pageRange(geo, 1)).toEqual({ start: 50, end: 60 });
  });
});

describe('paginatorView — the <Pagination> view-model', () => {
  it('reads "Page 1 of 1" with 0 range for an empty set', () => {
    const view = paginatorView(0, 50, 0);
    expect(view).toEqual({ pageIndex: 0, pageCount: 1, from: 0, to: 0, total: 0 });
  });

  it('computes 1-based inclusive from/to for the first page', () => {
    const view = paginatorView(51, 50, 0);
    expect(view).toMatchObject({ pageIndex: 0, pageCount: 2, from: 1, to: 50, total: 51 });
  });

  it('computes the final partial page bounds', () => {
    const view = paginatorView(51, 50, 1);
    expect(view).toMatchObject({ pageIndex: 1, pageCount: 2, from: 51, to: 51, total: 51 });
  });

  it('clamps an out-of-range pageIndex into the valid range', () => {
    expect(paginatorView(120, 50, 99).pageIndex).toBe(2);
    expect(paginatorView(120, 50, -5).pageIndex).toBe(0);
  });

  // Feature: ihg-guest-search, Property 6 (view-model agreement): for any non-empty total
  // and any page size, the reported from/to bounds never leave [1, total] and the page
  // slice width (to - from + 1) matches the geometry's page range.
  // **Validates: Requirements 17.5, 17.12, 25.4**
  test.prop(
    [
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 1, max: 200 }),
      fc.integer({ min: 0, max: 50 }),
    ],
    { numRuns: NUM_RUNS },
  )('from/to stay within [1, total] and match the page geometry', (total, pageSize, rawIndex) => {
    const geo = clientPaginator(total, pageSize);
    const pageIndex = geo.pageCount === 0 ? 0 : rawIndex % geo.pageCount;
    const view = paginatorView(total, pageSize, pageIndex);

    expect(view.from).toBeGreaterThanOrEqual(1);
    expect(view.to).toBeLessThanOrEqual(total);
    expect(view.from).toBeLessThanOrEqual(view.to);

    const { start, end } = pageRange(geo, view.pageIndex);
    expect(view.from).toBe(start + 1);
    expect(view.to).toBe(end);
  });
});
