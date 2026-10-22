// usePaginator: the pagination abstraction (task 12.6, design.md "usePaginator.ts —
// clientPaginator(total, pageSize)", Req 17).
//
// Paginator decision (Req 17.2): the Paginator is an ABSTRACTION with a client-side
// implementation that "SHALL allow a server-side implementation without changing the
// table component". We realise that in two layers:
//
//   1. `clientPaginator(total, pageSize)` — a PURE function returning the page geometry
//      ({ pageCount, pages, pageIndexes, from(i), to(i) }) for a result set already
//      fully in memory. It is the client implementation of the paging math and the thing
//      the P6 partition property (Req 17.12, task 12.8) tests directly: concatenating the
//      pages reproduces indices 0..total-1 once each, and pageCount === ceil(total/size).
//
//   2. `usePaginator(table)` — a thin React adapter that derives the view-model
//      `{ pageIndex, pageCount, from, to, total }` the <Pagination> control renders, from
//      whatever drives the row slice. Here that driver is TanStack Table v9's
//      `rowPaginationFeature` (design.md: "TanStack rowPaginationFeature with
//      pageSize: 50"), which does the actual row slicing inside ResultsTable. A future
//      server Paginator would feed the table a manual page (manualPagination + rowCount)
//      and this same adapter/control would render unchanged — the seam Req 17.2 requires.
//
// The default page size is 50 (Req 17.1). from/to are 1-based inclusive bounds over the
// sorted set; on an empty set from/to are 0 so the control can render "0 of 0".

/** The default page size for the client Paginator (Req 17.1). */
export const DEFAULT_PAGE_SIZE = 50;

/** The view-model the <Pagination> control renders (design.md usePaginator shape). */
export interface PaginatorView {
  /** Zero-based index of the current page. */
  pageIndex: number;
  /** Total number of pages (>= 1 so "Page 1 of 1" reads sensibly even when empty). */
  pageCount: number;
  /** 1-based index of the first visible row (0 when there are no results). */
  from: number;
  /** 1-based index of the last visible row (0 when there are no results). */
  to: number;
  /** Total number of results across all pages. */
  total: number;
}

/** The geometry of a client-side paginated set (the pure paging math). */
export interface ClientPagination {
  /** Total result count. */
  total: number;
  /** Rows per page (>= 1). */
  pageSize: number;
  /** Number of pages: `Math.ceil(total / pageSize)`, and 0 when total is 0. */
  pageCount: number;
  /** Zero-based page indexes `[0 .. pageCount - 1]`. */
  pageIndexes: number[];
}

/**
 * Pure client-side paginator. Given a total and a page size, return the page geometry.
 *
 * Invariants (the P6 partition property, Req 17.12):
 *   - `pageCount === Math.ceil(total / pageSize)` (and 0 when `total === 0`).
 *   - the half-open row ranges `[from(i), to(i))` for i in `pageIndexes` tile `[0, total)`
 *     exactly: every index appears on exactly one page, in order, none repeated or lost.
 *
 * `pageSize` is clamped to at least 1 so a misconfiguration can never divide by zero or
 * produce an infinite page count.
 */
export function clientPaginator(
  total: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): ClientPagination {
  const size = Math.max(1, Math.floor(pageSize));
  const count = total <= 0 ? 0 : Math.ceil(total / size);
  const pageIndexes = Array.from({ length: count }, (_unused, i) => i);
  return { total: Math.max(0, total), pageSize: size, pageCount: count, pageIndexes };
}

/**
 * The half-open row range `[start, end)` (zero-based) for a given page of a client set.
 * Returns `[0, 0)` for pages that fall outside the set.
 */
export function pageRange(
  pagination: ClientPagination,
  pageIndex: number,
): { start: number; end: number } {
  if (pageIndex < 0 || pageIndex >= pagination.pageCount) return { start: 0, end: 0 };
  const start = pageIndex * pagination.pageSize;
  const end = Math.min(start + pagination.pageSize, pagination.total);
  return { start, end };
}

/**
 * Derive the <Pagination> view-model from the current page geometry. Shared by the React
 * adapter (below) and usable directly in tests. `pageCount` is reported as at least 1 so
 * the control always reads "Page 1 of 1"; `from`/`to` are 1-based inclusive, 0 when empty.
 */
export function paginatorView(total: number, pageSize: number, pageIndex: number): PaginatorView {
  const geo = clientPaginator(total, pageSize);
  const displayCount = Math.max(1, geo.pageCount);
  if (geo.total === 0) {
    return { pageIndex: 0, pageCount: displayCount, from: 0, to: 0, total: 0 };
  }
  const safeIndex = Math.min(Math.max(0, pageIndex), geo.pageCount - 1);
  const { start, end } = pageRange(geo, safeIndex);
  return {
    pageIndex: safeIndex,
    pageCount: displayCount,
    from: start + 1,
    to: end,
    total: geo.total,
  };
}
