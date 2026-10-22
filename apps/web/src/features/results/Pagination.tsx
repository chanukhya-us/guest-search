// Pagination: the results paging control (task 12.6, design.md "Pagination.tsx — nav,
// Prev/Next, numbered, page select, range text", Req 17).
//
// A labelled <nav aria-label="Search results pagination"> containing, in reading order:
//   - the result range text "Showing {from}–{to} of {total} guests" (Req 17.5), which is
//     always shown — even for a single page — so the colleague always sees how many
//     results matched;
//   - Previous / numbered page buttons / Next, plus a page <select>, which are shown only
//     when there is more than one page (Req 17.10: with 50 or fewer guests, i.e. a single
//     page at the default size, the range is shown and the numbered controls are hidden).
//
// Accessibility (Req 17.3, 17.4, 24):
//   - The whole control is a single labelled landmark, so a screen-reader user can jump
//     to "Search results pagination" and read the range immediately.
//   - Previous is disabled on the first page (Req 17.6) and Next on the last (Req 17.7);
//     disabled buttons use the native `disabled` attribute so they leave the tab order.
//   - The current page button carries `aria-current="page"` and is styled with the navy
//     fill + white bold text; the state is conveyed in TEXT ("Page N, current page"), not
//     by colour alone (Req 15.6 principle, 24.5).
//   - Every button has an explicit accessible name including the page number so the names
//     are unambiguous out of context ("Go to page 3"), and 36×36 targets (ihg-brand-ui)
//     sit well above the 24px floor (Req 24.6).
//   - Focus movement and the "Page {n} of {pages}" announcement on a page change are the
//     responsibility of the owner (ResultsTable), which knows the caption node and the
//     StatusRegion; this control is a pure, controlled presentation of the view-model.
import type { PaginatorView } from './usePaginator.js';

export interface PaginationProps {
  /** The current page geometry to render (1-based from/to, zero-based pageIndex). */
  view: PaginatorView;
  /** Go to a specific zero-based page index (clamped by the caller/table). */
  onPageChange: (pageIndex: number) => void;
}

/**
 * The pagination control. Renders the range text unconditionally and the page navigation
 * only when there is more than one page. Pure and controlled: it never owns page state,
 * it just reflects `view` and reports intent through `onPageChange`.
 */
export function Pagination({ view, onPageChange }: PaginationProps) {
  const { pageIndex, pageCount, from, to, total } = view;
  const multiPage = pageCount > 1;

  return (
    <nav
      aria-label="Search results pagination"
      className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
      data-testid="pagination"
    >
      {/* Range text (Req 17.5) — always visible, even for a single page. */}
      <p className="text-sm text-text-2" data-testid="pagination-range">
        Showing {from}&ndash;{to} of {total} {total === 1 ? 'guest' : 'guests'}
      </p>

      {/* Numbered controls (Req 17.3) — hidden when there is only one page (Req 17.10). */}
      {multiPage && (
        <div className="flex flex-wrap items-center gap-2">
          <PageButton
            label="Previous page"
            onClick={() => onPageChange(pageIndex - 1)}
            disabled={pageIndex === 0}
          >
            {/* The visible text ("Previous") must be part of the accessible name
                ("Previous page") to satisfy WCAG 2.5.3 Label in Name; the arrow glyph is
                decorative. */}
            <span aria-hidden="true" className="mr-1">
              ‹
            </span>
            <span>Previous</span>
          </PageButton>

          <ol className="flex flex-wrap items-center gap-1" data-testid="pagination-pages">
            {Array.from({ length: pageCount }, (_unused, i) => i).map((i) => {
              const isCurrent = i === pageIndex;
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onPageChange(i)}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={
                      isCurrent
                        ? 'inline-flex h-9 min-w-9 items-center justify-center rounded-chip bg-navy px-3 font-bold text-surface'
                        : 'inline-flex h-9 min-w-9 items-center justify-center rounded-chip border border-navy px-3 text-navy hover:bg-navy-wash'
                    }
                  >
                    <span aria-hidden="true">{i + 1}</span>
                    <span className="sr-only">
                      {isCurrent ? `Page ${i + 1}, current page` : `Go to page ${i + 1}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <PageButton
            label="Next page"
            onClick={() => onPageChange(pageIndex + 1)}
            disabled={pageIndex >= pageCount - 1}
          >
            {/* Visible "Next" is part of the accessible name "Next page" (WCAG 2.5.3). */}
            <span>Next</span>
            <span aria-hidden="true" className="ml-1">
              ›
            </span>
          </PageButton>

          {/* Page selection control (Req 17.3): jump directly to a page. */}
          <label className="ml-1 flex items-center gap-2 text-sm text-text-2">
            <span>Page</span>
            <select
              value={pageIndex}
              onChange={(e) => onPageChange(Number(e.target.value))}
              className="h-9 rounded-control border border-border-strong bg-surface px-2 text-body"
              data-testid="pagination-select"
              aria-label="Go to page"
            >
              {Array.from({ length: pageCount }, (_unused, i) => i).map((i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
            <span>of {pageCount}</span>
          </label>
        </div>
      )}
    </nav>
  );
}

/** A Prev/Next button with a 36px target, navy border and a clear accessible name. */
function PageButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="inline-flex h-9 items-center justify-center rounded-chip border border-navy px-3 text-navy hover:bg-navy-wash disabled:cursor-not-allowed disabled:border-border disabled:text-muted disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
