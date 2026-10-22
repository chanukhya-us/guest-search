# Manual accessibility checklist (WCAG 2.2 AA)

> This checklist is completed **by a human** with assistive technologies. It covers the items
> an automated scan cannot verify.

The E2E suite runs an automated **axe** scan (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`,
`wcag22aa`, colour-contrast enabled) over every UI state and fails the build on any violation.

**The automated gate does not prove WCAG conformance.** Automated tools catch only a fraction
of accessibility issues — they cannot judge reading order, focus management, screen-reader
announcements, meaningful alternative text, or cognitive clarity. A clean axe run is a
_regression gate_, not a conformance claim. WCAG 2.2 AA conformance requires completing the
manual testing below **and** an expert review, over full pages and complete processes. Until
that is done and recorded, conformance status is **Not determined**.

## Test environment

Record what was actually tested — a result only applies to the combination used.

- [ ] Screen reader + browser: **NVDA + Firefox** (Windows)
- [ ] Screen reader + browser: **NVDA + Chrome** (Windows)
- [ ] Screen reader + browser: **VoiceOver + Safari** (macOS)
- [ ] Keyboard-only (no pointing device), each supported browser
- [ ] Browser zoom **200%** and **400%**; reflow at **320 px** width
- [ ] `prefers-reduced-motion` enabled
- [ ] OS high-contrast / forced-colors mode
- [ ] Date / build / app version under test: \_\_\_\_\_\_\_\_

## States to test

Exercise every state the axe fixture scans, with AT and keyboard:

- [ ] Initial form (empty)
- [ ] Validation errors (all-blank submit; per-field errors; server `VALIDATION_ERROR`)
- [ ] Loading / searching
- [ ] Results table (with sorting and pagination)
- [ ] Empty results
- [ ] Upstream error with "Try again"
- [ ] Details drawer open
- [ ] Reveal performed (role on) and reveal unavailable (role off)
- [ ] Reveal expired message

## 1. Perceivable

- [ ] Every form control has a visible, programmatically associated label.
- [ ] Status is conveyed by **text and icon**, never colour alone (1.4.1).
- [ ] Text contrast ≥ 4.5:1; large text and UI component/graphic contrast ≥ 3:1 (1.4.3, 1.4.11).
- [ ] At 400% zoom and 320 px reflow, no content is lost and there is no two-dimensional
      horizontal scroll for the form (1.4.10).
- [ ] The brand logo / wordmark has an appropriate text alternative; decorative icons are
      hidden from AT (1.1.1).
- [ ] Masked values (`•••• 1234`, `a•••@domain`) read sensibly to a screen reader and are not
      mistaken for the real value.

## 2. Operable

- [ ] Every interactive element is reachable and operable by keyboard alone; no keyboard traps
      (2.1.1, 2.1.2).
- [ ] A visible skip link moves focus to `<main>`.
- [ ] Focus order follows the visual/logical order through the form, table and pagination
      (2.4.3).
- [ ] Focus is always visible (2px navy outline, 2px offset) on every control (2.4.7, 2.4.11
      focus not obscured).
- [ ] Interactive target size is at least 24×24 px (2.5.8).
- [ ] `/` keyboard shortcut and Enter-to-submit behave predictably and do not hijack typing in
      inputs (2.1.4 character-key shortcuts).
- [ ] **Details drawer:** focus moves into the dialog on open, is trapped while open, Esc and
      Close dismiss it, and focus returns to the trigger (2.4.3, 2.1.2).
- [ ] **Pagination:** Prev/Next disabled at the ends; current page marked `aria-current="page"`;
      on page change focus moves to the table caption.
- [ ] **Sorting:** sortable columns are operable by keyboard and expose `aria-sort`.

## 3. Understandable

- [ ] `<html lang="en">` is set (3.1.1).
- [ ] The error summary lists each error, its links move focus to the offending field, and the
      summary itself receives focus on submit (3.3.1).
- [ ] Inline errors are programmatically associated (`aria-describedby`, `aria-invalid`) and
      prefixed "Error:" (3.3.1).
- [ ] Error messages describe how to fix the problem and never echo the submitted value (3.3.3).
- [ ] Labels and instructions are present and consistent; navigation is consistent across
      states (3.2.x).
- [ ] Reveal and other help text are in plain language.

## 4. Robust

- [ ] Custom widgets (country combobox, member-type select, drawer/dialog, sortable table,
      pagination) expose correct roles, states and properties and follow the WAI-ARIA
      Authoring Practices (4.1.2).
- [ ] **Live regions:** status messages ("Searching…", "{n} guests found", "Page n of m",
      "Copied", "Search cleared") are announced exactly once — the polite status region and the
      error `role="alert"` do not double-announce (4.1.3).
- [ ] Dynamic state changes (loading → results, reveal) are announced without stealing focus
      unexpectedly.

## Findings

Record outcomes per criterion: PASS / FAIL / NOT TESTED / NOT APPLICABLE, with evidence
(screen-reader transcript, screenshot, or note).

| Area / criterion | AT + browser | Result | Evidence / notes |
| ---------------- | ------------ | ------ | ---------------- |
|                  |              |        |                  |

## Conformance statement

- **Overall conformance:** Not determined until the manual testing above is completed and an
  expert review is performed over full pages and complete processes.
- **Untested scope:** list any states, pages or AT combinations not assessed.
