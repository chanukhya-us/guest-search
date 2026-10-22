# ADR 0005: Client-side pagination of a bounded result set

## Status

Accepted.

## Context

Search results must be presented in a sortable, paginated table. The forces:

- The upstream returns a **bounded** result set: the BFF sends `maxResults` (default 50,
  configurable) in the request and the service returns at most that many guests. There is no
  evidence of a server-side paging contract (`offset`, `pageNumber`, continuation tokens) in
  the sample, and inventing one would violate the "never invent contract fields" rule
  (Blocker B1).
- The whole result set is already in the browser after one call, so it is small enough to sort
  and page in memory.
- We do not want to couple the table component to a paging mechanism we may have to change when
  the real contract arrives — the requirement (Req 17.2) explicitly asks that a server-side
  paginator be swappable **without changing the table component**.

## Decision

Paginate **client-side**, behind a `Paginator` abstraction, over the result set already in
memory:

- `clientPaginator(total, pageSize)`
  ([`usePaginator.ts`](../../apps/web/src/features/results/usePaginator.ts)) is a **pure**
  function returning the page geometry; TanStack Table's row-pagination feature does the
  actual row slicing. Default page size is 50 (Req 17.1).
- `usePaginator(table)` is a thin adapter that produces the view-model
  (`pageIndex`, `pageCount`, `from`, `to`, `total`) the `<Pagination>` control renders.
- A future **server-side** paginator feeds the table a manual page (`manualPagination` +
  `rowCount`); the same adapter and control render unchanged. That is the seam Req 17.2
  requires.
- Numbered page controls are hidden at 50 or fewer results; the control always reads sensibly
  ("Page 1 of 1", "0 of 0" when empty). The partition property (every row index appears on
  exactly one page, in order) is covered by a property test (P6).

## Consequences

Easier:

- No dependence on an unconfirmed server paging contract — nothing invented, B1 not blocked
  further by the table.
- Sorting and paging are instant (in memory), with no extra round-trips.
- Pagination is simple to test exhaustively as pure geometry.

Harder / accepted:

- This works **only because the result set is bounded** by `maxResults`. If the upstream ever
  returns a large, unbounded set, client-side paging would not scale and the server-side
  implementation behind the abstraction must be wired in.
- The UI shows at most `maxResults` guests and surfaces a "limited results" notice; it does not
  and cannot page beyond what the service returned. Changing that depends on a real
  server-side paging contract (B1).

## Related

- [0002](0002-hand-built-soap-envelope.md) — why no paging fields are invented in the request.
- [../open-questions.md](../open-questions.md) — B1 and the bounded-result-set assumption.
