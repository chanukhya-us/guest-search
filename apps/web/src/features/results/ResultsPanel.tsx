// ResultsPanel: the results region state switch (task 12.4, design.md
// "ResultsPanel.tsx — state switch: idle | loading | empty | error | results").
//
// It renders one of five states handed to it by the useGuestSearch controller. The real
// results table, pagination, drawer and reveal are later tasks (12.5–12.7); this panel
// owns the loading / empty / error states in full and, for the results state, renders a
// minimal summary line plus a placeholder list while handing the normalized data (and
// the reveal-role flag) down to the table boundary. Keeping that boundary clean means
// task 12.5 can drop ResultsTable in without touching the controller or the other states.
//
// Accessibility (Req 18, 24.9):
//   - The region wrapper carries aria-busy while loading (Req 18.1) and is labelled.
//   - Non-error state changes are announced politely by the controller via StatusRegion;
//     this panel does not re-announce them.
//   - The error state is a role="alert" (Req 18.6); it announces itself, so the status
//     region stays silent for errors (no double announcement).
//   - On results, the controller announces "{n} guests found"; this panel exposes the
//     summary caption as the focus target (Req 18.4) via a tabIndex -1 heading.
import type { GuestSearchResponse, GuestSummary, UiConfig } from '@ihg-guest-search/shared';
import { useEffect, useId, useRef } from 'react';

import { AlertIcon, RetryIcon, Spinner } from '../../components/icons.js';
import type { SearchState } from '../search/useGuestSearch.js';
import { ResultsTable } from './ResultsTable.js';
import type { RevealMap } from './useReveal.js';

interface ResultsPanelProps {
  state: SearchState;
  /** Whether the signed-in colleague may reveal PII (passed down to the table, Req 14.12). */
  canReveal: boolean;
  /** The in-memory reveal store shared by the table and the drawer (Req 14.12, 14.13). */
  reveal: RevealMap;
  /** Score-band thresholds from UiConfig, used to label each row's match score (Req 15.6). */
  scoreBands: UiConfig['scoreBands'];
  /** Open the details drawer for a guest (Req 16.1). */
  onSelect: (summary: GuestSummary) => void;
  /** Re-run the last search (Try again on the error state, Req 18.7). */
  onRetry: () => void;
}

export function ResultsPanel({
  state,
  canReveal,
  reveal,
  scoreBands,
  onSelect,
  onRetry,
}: ResultsPanelProps) {
  return (
    <section
      aria-label="Search results"
      aria-busy={state.kind === 'loading'}
      className="mt-8"
      data-testid="results-panel"
    >
      {state.kind === 'idle' && <IdleState />}
      {state.kind === 'loading' && <LoadingState />}
      {state.kind === 'empty' && <EmptyState />}
      {state.kind === 'error' && <ErrorState state={state} onRetry={onRetry} />}
      {state.kind === 'results' && (
        <ResultsState
          response={state.response}
          canReveal={canReveal}
          reveal={reveal}
          scoreBands={scoreBands}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}

/**
 * Loading state (Req 18.1): a labelled busy block with skeleton rows. The animation is
 * disabled under prefers-reduced-motion by the global reset (Req 18.9). The polite
 * "Searching guests…" announcement is made by the controller, not duplicated here.
 */
function LoadingState() {
  return (
    <div className="animate-fade-in rounded-card bg-surface p-6 shadow-panel">
      <p className="flex items-center gap-2 text-text-2">
        <span className="text-navy">
          <Spinner />
        </span>
        Searching for guests…
      </p>
      <ul className="mt-4 space-y-2" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="flex items-center gap-4 rounded-control px-2 py-2">
            <span className="skeleton h-8 w-8 shrink-0 rounded-full" />
            <span className="skeleton h-3 w-1/5 rounded-full" />
            <span className="skeleton h-3 w-1/4 rounded-full" />
            <span className="skeleton hidden h-3 w-1/6 rounded-full md:block" />
            <span className="skeleton ml-auto h-3 w-16 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Idle state: a calm, illustrated starting point so the page never looks empty before the
 * first search. Purely informational (not a live region); the illustration is decorative.
 */
function IdleState() {
  return (
    <div className="flex animate-fade-in flex-col items-center gap-6 rounded-card border border-dashed border-border bg-surface/70 px-6 py-10 text-center md:flex-row md:text-left">
      <img
        src="/illustrations/search-start.svg"
        alt=""
        width={180}
        height={135}
        className="h-auto w-40 shrink-0 md:w-44"
      />
      <div>
        <h2 className="text-xl font-semibold text-navy">Ready when you are</h2>
        <p className="mt-2 max-w-xl text-text-2">
          Results appear here, ranked by match score. Start with a last name, email, phone number or
          loyalty member ID. Combining fields narrows the matches.
        </p>
      </div>
    </div>
  );
}

/**
 * Empty state (Req 18.5): a clear, non-error message with guidance for broadening the
 * search. Not an alert — zero results is a success outcome.
 */
function EmptyState() {
  return (
    <div className="flex animate-rise-in flex-col items-center gap-6 rounded-card bg-surface p-6 shadow-panel md:flex-row md:items-start">
      <img
        src="/illustrations/no-results.svg"
        alt=""
        width={160}
        height={128}
        className="h-auto w-36 shrink-0"
      />
      <div>
        <h2 className="text-xl font-semibold text-navy">No guests found</h2>
        <p className="mt-2 text-text-2">No guests found matching the search criteria.</p>
        <p className="mt-3 text-text-2">To broaden your search, try:</p>
        <ul className="mt-1 list-disc pl-6 text-text-2">
          <li>Using fewer criteria.</li>
          <li>Checking the spelling of names.</li>
          <li>Searching by last name or loyalty member ID alone.</li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Error state (Req 18.6, 19): a role="alert" panel showing the user-safe catalog
 * message, the request reference for support, and a "Try again" button that re-runs the
 * last criteria (Req 18.7). It never shows the error code, stack traces or raw detail
 * (Req 15.10, 19.3).
 */
function ErrorState({
  state,
  onRetry,
}: {
  state: Extract<SearchState, { kind: 'error' }>;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex animate-rise-in items-start gap-3 rounded-card border-l-4 border-error bg-error-wash p-4 shadow-panel"
    >
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface text-error"
      >
        <AlertIcon size={16} />
      </span>
      <div>
        <h2 className="text-xl font-semibold text-navy">Search failed</h2>
        <p className="mt-1 text-body">{state.message}</p>
        {state.requestId && (
          <p className="mt-1 text-sm text-text-2">
            Reference: <span className="font-mono">{state.requestId}</span>
          </p>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex h-12 items-center gap-2 rounded-control border border-navy bg-surface px-6 text-base font-medium text-navy transition duration-150 hover:bg-navy-wash"
        >
          <RetryIcon size={16} />
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * Results state: the summary heading plus the results table (task 12.5).
 *
 * The summary heading is the focus target for Req 18.4: on a successful search the
 * controller announces "{n} guests found" and the user's focus lands here. The table
 * itself carries its own <caption> (the table's accessible name and the scroll region's
 * label, Req 15.3/15.8). The limited-results notice (Req 15.11) appears when
 * totalResults === limit, and never implies more records can be fetched.
 */
function ResultsState({
  response,
  canReveal,
  reveal,
  scoreBands,
  onSelect,
}: {
  response: GuestSearchResponse;
  canReveal: boolean;
  reveal: RevealMap;
  scoreBands: UiConfig['scoreBands'];
  onSelect: (summary: GuestSummary) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const captionId = useId();
  const { totalResults, limit, results } = response;

  // Move focus to the summary heading when a new result set renders (Req 18.4). Keyed on
  // the result-set identity (count) so it fires once per search, not on every re-render.
  useEffect(() => {
    headingRef.current?.focus();
  }, [totalResults]);

  const limited = totalResults === limit;

  return (
    <div className="animate-rise-in">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-3 text-xl font-semibold text-navy outline-none"
      >
        <span
          aria-hidden="true"
          className="h-6 w-1 rounded-full bg-gradient-to-b from-primary to-decorative"
        />
        {summaryText(totalResults)}
      </h2>

      {limited && (
        <p className="mt-2 text-text-2" data-testid="limited-notice">
          Results are limited to the first {limit} matches. Refine your search to narrow the
          results.
        </p>
      )}

      <ResultsTable
        results={results}
        scoreBands={scoreBands}
        canReveal={canReveal}
        reveal={reveal}
        captionId={captionId}
        onSelect={onSelect}
      />
    </div>
  );
}

/**
 * The visible results summary heading. Matches the Req 18.4 announcement exactly
 * ("{n} guests found") so the heading and the polite announcement read identically.
 */
function summaryText(total: number): string {
  return `${total} guests found`;
}
