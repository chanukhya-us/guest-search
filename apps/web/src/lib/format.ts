// Presentation helpers for the results table (task 12.5, design.md "lib/format.ts").
//
// These are pure, side-effect-free formatters. They never unmask, reformat or
// synthesize contact data: masked phone/email strings arrive already masked from the
// BFF (Req 14) and are shown verbatim. Absent values render a single empty indicator so
// the table scans cleanly and screen readers announce a consistent "not provided" cell
// rather than an empty one (Req 15.2, 24).
import type { GuestSearchResult, UiConfig } from '@ihg-guest-search/shared';

/** The visible marker for an absent primary field (Req 15.2). An em dash reads as
 * "not provided" via the cell's aria text; we pair it with a visually-hidden label. */
export const EMPTY_INDICATOR = '—';

/** Accessible text for an absent value, used in aria-label / visually-hidden spans. */
export const EMPTY_LABEL = 'Not provided';

/** The three match-score bands, in descending quality order (Req 15.6). */
export type ScoreBand = 'high' | 'medium' | 'low';

/** Human-facing band label used next to the numeric score (Req 15.6). */
export const SCORE_BAND_LABEL: Record<ScoreBand, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Map a numeric score to a band using the configurable thresholds (Req 15.6,
 * design.md: `score >= high` → High, `>= medium` → Medium, else Low). A missing or
 * non-numeric score has no band — callers render the empty indicator instead.
 */
export function scoreBand(
  score: number | undefined,
  bands: UiConfig['scoreBands'],
): ScoreBand | undefined {
  if (typeof score !== 'number' || Number.isNaN(score)) return undefined;
  if (score >= bands.high) return 'high';
  if (score >= bands.medium) return 'medium';
  return 'low';
}

/** The guest's display name for accessible labels ("View details for {name}", Req 16.1).
 * Falls back to the Enterprise ID when no name is present so the label is never empty. */
export function guestDisplayName(guest: GuestSearchResult): string {
  const name = [guest.firstName, guest.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : `guest ${guest.enterpriseId}`;
}

/** Render a value or the empty indicator. Keeps empty strings out of cells. */
export function orEmpty(value: string | undefined | null): string {
  return value != null && value !== '' ? value : EMPTY_INDICATOR;
}
