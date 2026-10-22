// Title manager (Req 24.11): the document title is "{state} – Guest Search – IHG".
//
// design.md lists the states: Search, Searching, {n} results, No results, Error,
// Fix errors. Task 12.2 owns the shell, so the idle state ("Search") is wired here;
// the search/results tasks (12.4) feed the result-bearing states through the same
// setDocumentTitle helper. The separator is an en dash (– U+2013), matching Req 24.11.
import { useEffect } from 'react';

const SUFFIX = 'Guest Search – IHG';

/** Build the full document title for a given state label. */
export function buildTitle(stateLabel: string): string {
  return `${stateLabel} – ${SUFFIX}`;
}

/** Imperatively set the document title (used by non-component callers and the hook). */
export function setDocumentTitle(stateLabel: string): void {
  document.title = buildTitle(stateLabel);
}

/** Keep document.title in sync with the current search-state label. */
export function useTitle(stateLabel: string): void {
  useEffect(() => {
    setDocumentTitle(stateLabel);
  }, [stateLabel]);
}
