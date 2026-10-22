// ResultsTable: the semantic results table (task 12.5, design.md "Results table details",
// Req 15, 13, 14, 23, 24).
//
// react-table decision: the pinned dependency is @tanstack/react-table 9.3.1 — the NEW
// modular, feature-based TanStack Table v9 (createColumnHelper / useTable with explicit
// `features`, atom-backed state), NOT the legacy hook-based `react-table` v9 (unscoped).
// design.md was written for exactly this API ("TanStack rowSortingFeature / custom score
// comparator"). We therefore drive SORTING STATE and the SORTED ROW ORDER through
// useTable + rowSortingFeature + createSortedRowModel, and render the table MARKUP by
// hand. Hand-authoring the markup (rather than flexRender-ing header groups) gives us
// full control of the accessible semantics Req 15.3/24 require: a real <table> with a
// <caption>, <th scope="col"> headers, an Enterprise ID row header (<th scope="row">),
// and sort buttons that set aria-sort only on the active column.
//
// Scope of this task: the table, its sorting and its pagination (task 12.6). Only the
// current page's rows render in <tbody>; the reveal affordance is task 12.7 (canReveal is
// threaded through; each row exposes a "View details" button that calls onSelect, the
// seam the drawer wires into). Masked phone/email arrive already masked from the BFF and
// are shown verbatim — this component never unmasks (Req 14).
//
// Pagination (Req 17): the sorted set is sliced client-side by TanStack Table v9's
// `rowPaginationFeature` (+ `createPaginatedRowModel`) at a default page size of 50
// (Req 17.1). Page/sort state is controlled here so that:
//   - changing the sort resets to page 1 (a stale page index would point past the newly
//     ordered rows), and
//   - a new result set resets to page 1 (Req 17.8) — the controller remounts/feeds a new
//     `results` array, and we reset the page index whenever that identity changes.
// On a page change we move focus to the <caption> and announce "Page {n} of {pages}" in
// the StatusRegion (Req 17.9); the <Pagination> control itself is pure and controlled.
import type { GuestSummary, UiConfig } from '@ihg-guest-search/shared';
import { pickPrimary } from '@ihg-guest-search/shared';
import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type PaginationState,
  type SortingState,
} from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useStatusRegion } from '../../a11y/StatusRegion.js';
import { EMPTY_INDICATOR, EMPTY_LABEL, guestDisplayName, orEmpty } from '../../lib/format.js';
import { scoreCompare, textCompare } from '../../lib/sort.js';
import { Pagination } from './Pagination.js';
import { ScoreBandChip } from './ScoreBand.js';
import { DEFAULT_PAGE_SIZE, paginatorView } from './usePaginator.js';
import { REVEAL_EXPIRED_MESSAGE, useRevealAction, type RevealMap } from './useReveal.js';

/**
 * The feature set for the table: core + row sorting + row pagination, with the sorted and
 * paginated row models wired in. The pipeline runs sort → paginate, so `getRowModel()`
 * returns exactly the current page of the sorted set.
 */
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
});

const helper = createColumnHelper<typeof features, GuestSummary>();

/**
 * The sortable column ids (Req 15.7: Match Score, First Name, Last Name, City, Country).
 * Everything else is display-only. Kept as a literal set so the header renderer can ask
 * "is this column sortable?" without duplicating the list.
 */
const SORTABLE = new Set(['score', 'firstName', 'lastName', 'city', 'country']);

/**
 * Column metadata driving the hand-rendered markup. Each entry pairs a TanStack column id
 * with its visible header and a cell renderer reading from the GuestSummary. The order is
 * exactly Req 15.1: Match Score, Enterprise ID, First Name, Last Name, Address, City,
 * State or Region, Postal Code, Country, Phone, Email, Loyalty Member ID, Member Type,
 * Membership Status (14 columns). Enterprise ID is rendered as the row header separately.
 */
interface ColumnMeta {
  id: string;
  header: string;
  /** Marks the Enterprise ID column, rendered as <th scope="row"> not <td>. */
  rowHeader?: boolean;
}

const COLUMN_META: readonly ColumnMeta[] = [
  { id: 'score', header: 'Match score' },
  { id: 'enterpriseId', header: 'Enterprise ID', rowHeader: true },
  { id: 'firstName', header: 'First name' },
  { id: 'lastName', header: 'Last name' },
  { id: 'address', header: 'Address' },
  { id: 'city', header: 'City' },
  { id: 'stateOrRegion', header: 'State or region' },
  { id: 'postalCode', header: 'Postal code' },
  { id: 'country', header: 'Country' },
  { id: 'phone', header: 'Phone' },
  { id: 'email', header: 'Email' },
  { id: 'memberId', header: 'Loyalty member ID' },
  { id: 'memberType', header: 'Member type' },
  { id: 'membershipStatus', header: 'Membership status' },
];

/**
 * TanStack column definitions. Only the sortable columns carry accessors + a sortFn so
 * the sorting engine orders by the raw value; display-only columns are plain accessors
 * with sorting disabled. The accessors read the primaries selected by the BFF (Req 13) —
 * we never re-pick (design.md "accessors read from GuestSummary.primary.* and guest.*").
 */
const columns = helper.columns([
  helper.accessor((s) => s.guest.score, {
    id: 'score',
    enableSorting: true,
    sortFn: (a, b) => scoreCompare(a.original.guest.score, b.original.guest.score),
    sortUndefined: 'last',
  }),
  helper.accessor((s) => s.guest.firstName, {
    id: 'firstName',
    enableSorting: true,
    sortFn: (a, b) => textCompare(a.original.guest.firstName, b.original.guest.firstName),
  }),
  helper.accessor((s) => s.guest.lastName, {
    id: 'lastName',
    enableSorting: true,
    sortFn: (a, b) => textCompare(a.original.guest.lastName, b.original.guest.lastName),
  }),
  helper.accessor((s) => s.primary.address?.city, {
    id: 'city',
    enableSorting: true,
    sortFn: (a, b) =>
      textCompare(a.original.primary.address?.city, b.original.primary.address?.city),
  }),
  helper.accessor((s) => s.primary.address?.country, {
    id: 'country',
    enableSorting: true,
    sortFn: (a, b) =>
      textCompare(a.original.primary.address?.country, b.original.primary.address?.country),
  }),
]);

export interface ResultsTableProps {
  /** The result set (BFF-selected primaries, phones/emails already masked, Req 13/14). */
  results: readonly GuestSummary[];
  /** The score-band thresholds from UiConfig (Req 15.6). */
  scoreBands: UiConfig['scoreBands'];
  /** Whether the colleague may reveal PII; gates the per-row reveal affordance (Req 14.12). */
  canReveal: boolean;
  /** The in-memory reveal store shared with the drawer (Req 14.12, 14.13). */
  reveal: RevealMap;
  /** The id of the table caption, so the scroll region can be labelled by it (Req 15.8). */
  captionId: string;
  /** Opens the details drawer for a guest (Req 16.1). */
  onSelect: (summary: GuestSummary) => void;
}

/**
 * The results table. Renders a horizontally scrollable, keyboard-focusable region
 * (Req 15.8) wrapping a native <table> with a <caption>, column headers and one row per
 * guest. Sorting is handled by TanStack; the whole sorted set renders (pagination is
 * 12.6). The limited-results notice (Req 15.11) is rendered by ResultsPanel, which knows
 * totalResults and limit.
 */
export function ResultsTable({
  results,
  scoreBands,
  canReveal,
  reveal,
  captionId,
  onSelect,
}: ResultsTableProps) {
  const { announce } = useStatusRegion();

  // Default sort: Match Score descending, undefined scores last (design.md, Req 15.5).
  const [sorting, setSorting] = useState<SortingState>([{ id: 'score', desc: true }]);
  // Pagination state: page 0, 50 rows per page (Req 17.1). Controlled so we can reset it
  // on a sort change and on a new result set, and so <Pagination> stays pure.
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  // Precompute the set of duplicate Enterprise IDs so the row key can fall back to an
  // index-qualified key when an ID is missing or duplicated (Req 15.4).
  const duplicateIds = useMemo(() => findDuplicateIds(results), [results]);

  const data = useMemo(() => results as GuestSummary[], [results]);

  // Reset to page 1 whenever the result set changes identity, i.e. a new search (Req
  // 17.8). The controller feeds a fresh `results` array per search; keying the reset on
  // its reference identity makes "new search ⇒ page 1" deterministic without relying on
  // the table's autoReset heuristics.
  useEffect(() => {
    setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  }, [results]);

  const captionRef = useRef<HTMLTableCaptionElement>(null);

  const table = useTable({
    features,
    columns,
    data,
    getRowId: (summary, index) => rowKey(summary, index, duplicateIds),
    state: { sorting, pagination },
    onSortingChange: (updater) => {
      // Changing the sort invalidates the current page offset — go back to page 1 so the
      // colleague sees the top of the newly ordered set (Req 17.8 spirit, and avoids a
      // page index that points past the re-sorted rows).
      setSorting(updater);
      setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
    },
    onPaginationChange: setPagination,
    enableSortingRemoval: false,
    // We own the page reset explicitly (above); disable the built-in data-change auto
    // reset so it never fights the controlled state.
    autoResetPageIndex: false,
  });

  const rows = table.getRowModel().rows;
  const view = paginatorView(results.length, pagination.pageSize, pagination.pageIndex);

  // Announce the page and move focus to the caption when the colleague navigates between
  // pages (Req 17.9). We must NOT fire when the page moves because of a new search: that
  // moment is owned by ResultsPanel, which focuses the summary heading and announces
  // "{n} guests found" (Req 18.4). So we gate on the result-set identity: a page-index
  // change is treated as navigation only when `results` has not just changed.
  const prevResultsRef = useRef(results);
  const prevPageRef = useRef(pagination.pageIndex);
  useEffect(() => {
    const resultsChanged = prevResultsRef.current !== results;
    const pageChanged = prevPageRef.current !== pagination.pageIndex;
    prevResultsRef.current = results;
    prevPageRef.current = pagination.pageIndex;
    if (pageChanged && !resultsChanged) {
      captionRef.current?.focus();
      announce(`Page ${view.pageIndex + 1} of ${view.pageCount}`);
    }
  }, [results, pagination.pageIndex, announce, view.pageIndex, view.pageCount]);

  const goToPage = (pageIndex: number) => table.setPageIndex(pageIndex);

  return (
    <>
      <div
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
        className="relative mt-4 max-w-full overflow-x-auto rounded-card border border-border bg-surface shadow-panel"
        data-testid="results-scroll-region"
        data-can-reveal={canReveal}
      >
        <table className="w-full border-collapse text-sm">
          <caption
            id={captionId}
            ref={captionRef}
            tabIndex={-1}
            className="px-4 py-3 text-left text-base font-semibold text-navy outline-none"
          >
            Search results: {results.length} {results.length === 1 ? 'guest' : 'guests'}, sorted by
            match score. Showing {view.from}&ndash;{view.to} of {view.total}.
          </caption>
          <thead className="sticky top-0 z-10 bg-navy text-surface">
            <tr>
              {COLUMN_META.map((col) => {
                const sortable = SORTABLE.has(col.id);
                const sorted = sortable ? columnSortState(sorting, col.id) : false;
                return (
                  <th
                    key={col.id}
                    scope="col"
                    aria-sort={sortable ? sorted || 'none' : undefined}
                    className="whitespace-nowrap px-4 py-3 text-left font-semibold"
                  >
                    {sortable ? (
                      <SortButton
                        label={col.header}
                        direction={sorted}
                        onToggle={() => toggleSort(table, col.id)}
                      />
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
              {/* Actions column: the per-row "View details" affordance (Req 16.1). */}
              <th scope="col" className="whitespace-nowrap px-4 py-3 text-left font-semibold">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const summary = row.original;
              return (
                <ResultRow
                  key={row.id}
                  summary={summary}
                  scoreBands={scoreBands}
                  canReveal={canReveal}
                  reveal={reveal}
                  onSelect={onSelect}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/*
        Pagination control (Req 17) — OUTSIDE the scroll region because it is navigation,
        not tabular data. Driven by the same controlled page state; always rendered so the
        range text ("Showing X–Y of N") shows even on a single page (Req 17.5), while the
        numbered controls hide themselves at <= 50 results (Req 17.10).
      */}
      <Pagination view={view} onPageChange={goToPage} />
    </>
  );
}

/** One result row: the primaries laid out across the 14 columns plus the details button. */
function ResultRow({
  summary,
  scoreBands,
  canReveal,
  reveal,
  onSelect,
}: {
  summary: GuestSummary;
  scoreBands: UiConfig['scoreBands'];
  canReveal: boolean;
  reveal: RevealMap;
  onSelect: (summary: GuestSummary) => void;
}) {
  const { guest, primary, revealToken } = summary;
  const name = guestDisplayName(guest);
  const score = guest.score;

  // Shared reveal action for this row (Req 14.12). The reveal button in the masked cells
  // triggers it; on success the row's primary phone/email swap to the unmasked values
  // held in the in-memory map.
  const action = useRevealAction(guest.enterpriseId, name, reveal);
  const revealed = reveal.get(guest.enterpriseId);
  const canOfferReveal =
    canReveal && typeof revealToken === 'string' && revealed === undefined && !action.expired;

  return (
    <tr className="border-t border-border transition-colors duration-150 even:bg-surface-2 hover:bg-navy-wash focus-within:bg-navy-wash">
      {/* Match score + band (Req 15.6). Missing score shows the empty indicator. */}
      <td className="whitespace-nowrap px-4 py-3">
        {typeof score === 'number' && !Number.isNaN(score) ? (
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-body">{score}</span>
            <ScoreBandChip score={score} bands={scoreBands} />
          </span>
        ) : (
          <EmptyCell />
        )}
      </td>

      {/* Enterprise ID is the row header (Req 15.3). Never masked (Req 14.4). */}
      <th scope="row" className="whitespace-nowrap px-4 py-3 text-left font-medium text-body">
        {guest.enterpriseId}
      </th>

      <Cell value={guest.firstName} />
      <Cell value={guest.lastName} />
      <Cell value={primary.address?.line1} />
      <Cell value={primary.address?.city} />
      <Cell value={primary.address?.stateOrRegion} />
      <Cell value={primary.address?.postalCode} />
      <Cell value={primary.address?.country} />

      {/*
        Masked phone / email (Req 14.12). Shown verbatim until a reveal succeeds, at which
        point the primary unmasked values from the reveal map swap in. The reveal button
        (role + token only) lives in the phone cell and reveals both; the email cell shows
        the matching unmasked value. REVEAL_EXPIRED shows inline and keeps the masked view.
      */}
      <td className="whitespace-nowrap px-4 py-3 text-body">
        <MaskedContactCell
          maskedValue={primary.phone?.number}
          revealedValue={revealed ? pickPrimaryValue(revealed.phones, (p) => p.number) : undefined}
        />
        {canOfferReveal && (
          <RevealButton
            name={name}
            pending={action.pending}
            onReveal={() => revealToken && action.run(revealToken)}
          />
        )}
        {action.expired && (
          <span role="alert" className="mt-1 block text-xs text-error" data-testid="reveal-expired">
            {REVEAL_EXPIRED_MESSAGE}
          </span>
        )}
        {action.errorMessage && (
          <span role="alert" className="mt-1 block text-xs text-error">
            {action.errorMessage}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-body">
        <MaskedContactCell
          maskedValue={primary.email?.address}
          revealedValue={revealed ? pickPrimaryValue(revealed.emails, (e) => e.address) : undefined}
        />
      </td>

      {/* Loyalty member ID, Member Type, Membership Status — never masked (Req 14.4). */}
      <Cell value={primary.membership?.memberId} />
      <Cell value={primary.membership?.memberType} />
      <Cell value={primary.membership?.status} />

      <td className="whitespace-nowrap px-4 py-3">
        <button
          type="button"
          onClick={() => onSelect(summary)}
          className="inline-flex h-8 min-h-0 items-center rounded-control border border-navy px-3 text-navy hover:bg-navy-wash"
        >
          <span aria-hidden="true">View details</span>
          <span className="sr-only">View details for {name}</span>
        </button>
      </td>
    </tr>
  );
}

/**
 * The masked/unmasked content of a contact cell. Shows the unmasked value once revealed,
 * otherwise the masked value from the response (shown verbatim — this never unmasks). An
 * absent value renders the empty indicator.
 */
function MaskedContactCell({
  maskedValue,
  revealedValue,
}: {
  maskedValue: string | undefined;
  revealedValue: string | undefined;
}) {
  const value = revealedValue ?? maskedValue;
  const text = orEmpty(value ?? undefined);
  if (text === EMPTY_INDICATOR) return <EmptyCell />;
  return <span>{text}</span>;
}

/**
 * The per-row reveal control (Req 14.12). An icon button whose accessible name includes
 * the guest's name ("Reveal contact details for {First Last}", design.md). Shown only when
 * the colleague may reveal and the row has a token; the caller gates visibility.
 */
function RevealButton({
  name,
  pending,
  onReveal,
}: {
  name: string;
  pending: boolean;
  onReveal: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onReveal}
      disabled={pending}
      aria-label={`${pending ? 'Revealing contact details' : 'Reveal contact details'} for ${name}`}
      className="mt-1 inline-flex h-7 min-h-0 items-center rounded-control border border-navy px-2 text-xs text-navy hover:bg-navy-wash disabled:opacity-70"
    >
      <span aria-hidden="true">{pending ? 'Revealing…' : 'Reveal'}</span>
    </button>
  );
}

/** The primary item's string field from a revealed collection (Req 13 ordering). */
function pickPrimaryValue<T extends object>(
  items: readonly T[],
  read: (item: T) => string | undefined,
): string | undefined {
  const primary = pickPrimary(items);
  return primary ? read(primary) : undefined;
}

/** A plain data cell rendering the value or the accessible empty indicator. */
function Cell({ value }: { value: string | undefined | null }) {
  const text = orEmpty(value ?? undefined);
  if (text === EMPTY_INDICATOR) {
    return (
      <td className="whitespace-nowrap px-4 py-3 text-body">
        <EmptyCell />
      </td>
    );
  }
  return <td className="whitespace-nowrap px-4 py-3 text-body">{text}</td>;
}

/** The empty-value indicator with a visually-hidden "Not provided" for screen readers. */
function EmptyCell() {
  return (
    <span className="text-muted">
      <span aria-hidden="true">{EMPTY_INDICATOR}</span>
      <span className="sr-only">{EMPTY_LABEL}</span>
    </span>
  );
}

/**
 * A header sort button. It shows the column label and a direction indicator in TEXT (an
 * arrow glyph plus a visually-hidden description), never colour alone. aria-sort on the
 * parent <th> carries the state for assistive tech; the button announces the next action.
 */
function SortButton({
  label,
  direction,
  onToggle,
}: {
  label: string;
  direction: 'ascending' | 'descending' | false;
  onToggle: () => void;
}) {
  const glyph = direction === 'ascending' ? '▲' : direction === 'descending' ? '▼' : '';
  const stateText =
    direction === 'ascending'
      ? ', sorted ascending'
      : direction === 'descending'
        ? ', sorted descending'
        : ', not sorted';
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 font-semibold text-surface underline-offset-2 hover:underline"
    >
      <span>{label}</span>
      {glyph && (
        <span aria-hidden="true" className="text-xs">
          {glyph}
        </span>
      )}
      <span className="sr-only">{stateText}. Activate to change sorting.</span>
    </button>
  );
}

/** Translate TanStack's sort state for a column into an aria-sort value. */
function columnSortState(
  sorting: SortingState,
  columnId: string,
): 'ascending' | 'descending' | false {
  const entry = sorting.find((s) => s.id === columnId);
  if (!entry) return false;
  return entry.desc ? 'descending' : 'ascending';
}

/** Toggle sorting for a column via the table API (cycles desc → asc, never off). */
function toggleSort(
  table: ReturnType<typeof useTable<typeof features, GuestSummary>>,
  columnId: string,
): void {
  const column = table.getColumn(columnId);
  column?.toggleSorting();
}

/** Stable row key (Req 15.4): Enterprise ID when present and unique, else index-qualified. */
function rowKey(summary: GuestSummary, index: number, duplicateIds: ReadonlySet<string>): string {
  const id = summary.guest.enterpriseId;
  if (id && !duplicateIds.has(id)) return id;
  return `${id || 'row'}#${index}`;
}

/** Enterprise IDs that appear more than once in the result set (Req 15.4). */
function findDuplicateIds(results: readonly GuestSummary[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const s of results) {
    const id = s.guest.enterpriseId;
    if (!id) continue;
    if (seen.has(id)) dupes.add(id);
    else seen.add(id);
  }
  return dupes;
}
