// ErrorSummary: the validation summary shown above the form on a failed submit
// (Req 5.1, 5.2, 5.3).
//
// Behaviour:
//   - Renders a heading stating the number of problems and one link per problem
//     (Req 5.1). The root "at least one criterion" error has no field, so its link
//     targets the First Name input (the first thing to fix).
//   - Receives focus when it appears so keyboard and screen-reader users land on it
//     (Req 5.2). It is NOT a live region — moving focus here is the single
//     announcement, which avoids the double-announce a live region would cause
//     (design.md "Focus and announcements").
//   - Each link moves focus to the related input (Req 5.3): clicking it focuses the
//     control by id. Native in-page anchors (href="#id") also work, but we focus
//     explicitly so comboboxes/selects receive focus reliably.
import { useEffect, useRef } from 'react';

export interface SummaryItem {
  /** The input id to focus when the link is activated. */
  inputId: string;
  /** The field label (or "Search criteria" for the form-level error). */
  label: string;
  /** The validation message. */
  message: string;
}

interface ErrorSummaryProps {
  items: readonly SummaryItem[];
  /** Bumped on each failed submit so the summary re-takes focus even if already shown. */
  focusToken: number;
}

export function ErrorSummary({ items, focusToken }: ErrorSummaryProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (items.length > 0) headingRef.current?.focus();
    // focusToken changes on every failed submit, so a repeated failure re-focuses.
  }, [focusToken, items.length]);

  if (items.length === 0) return null;

  const count = items.length;
  const heading =
    count === 1
      ? 'There is 1 problem with your search'
      : `There are ${count} problems with your search`;

  function focusInput(inputId: string): void {
    const el = document.getElementById(inputId);
    if (el instanceof HTMLElement) el.focus();
  }

  // Not a live region (design.md "Focus and announcements"): it receives focus
  // instead, which is the single announcement and avoids a double-announce.
  return (
    <div className="rounded-card border-l-4 border-error bg-error-wash p-4">
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-error">
        {heading}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {items.map((item) => (
          <li key={`${item.inputId}:${item.message}`}>
            <a
              href={`#${item.inputId}`}
              className="text-error underline underline-offset-2"
              onClick={(e) => {
                e.preventDefault();
                focusInput(item.inputId);
              }}
            >
              {item.label}: {item.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
