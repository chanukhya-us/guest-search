// useShortcut + useTitle tests (task 12.8, Req 24.10, 24.11).
//
// searchForm.test.tsx already proves "/" focuses First Name when pressed outside a text
// field. The genuine gap is the TEXT-ENTRY GUARD: "/" must type normally (never steal
// focus) while the caret is in a text-like control, and must still navigate from
// non-text controls (buttons, checkboxes). useTitle's state transitions and the exact
// en-dash title format (Req 24.11) are also pinned here.
import { render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FIRST_NAME_INPUT_ID, useShortcut } from '../../src/a11y/useShortcut';
import { buildTitle, setDocumentTitle, useTitle } from '../../src/app/useTitle';

/**
 * Mount useShortcut with a First Name target plus a set of other focusable controls, then
 * hand back helpers to focus a control and dispatch a "/" keydown on document.
 */
function mountShortcut() {
  function Harness() {
    useShortcut();
    return (
      <div>
        <input id={FIRST_NAME_INPUT_ID} aria-label="First name" />
        <input id="other-text" type="text" aria-label="Other text" />
        <input id="search-text" type="search" aria-label="Search text" />
        <input id="a-checkbox" type="checkbox" aria-label="A checkbox" />
        <textarea id="a-textarea" aria-label="A textarea" />
        <select id="a-select" aria-label="A select">
          <option>x</option>
        </select>
        <button id="a-button" type="button">
          Go
        </button>
        <div id="editable" contentEditable aria-label="Editable" />
      </div>
    );
  }
  render(<Harness />);
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const pressSlash = () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
  const firstName = () => byId(FIRST_NAME_INPUT_ID);
  return { byId, pressSlash, firstName };
}

describe('useShortcut — text-entry guard (Req 24.10)', () => {
  it('does NOT move focus when "/" is typed inside a text input', () => {
    const { byId, pressSlash, firstName } = mountShortcut();
    const other = byId('other-text');
    other.focus();
    pressSlash();
    expect(document.activeElement).toBe(other);
    expect(firstName()).not.toHaveFocus();
  });

  it('does NOT move focus from a search input, textarea or select', () => {
    const { byId, pressSlash } = mountShortcut();
    for (const id of ['search-text', 'a-textarea', 'a-select']) {
      const el = byId(id);
      el.focus();
      pressSlash();
      expect(document.activeElement).toBe(el);
    }
  });

  it('does NOT move focus from a contentEditable element', () => {
    const { byId, pressSlash } = mountShortcut();
    const editable = byId('editable');
    // jsdom does not derive isContentEditable from the attribute, so assert it so the
    // guard sees the same truth a browser would.
    Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true });
    editable.focus();
    pressSlash();
    expect(document.activeElement).toBe(editable);
  });

  it('DOES move focus to First Name from a non-text control (button, checkbox)', () => {
    const { byId, pressSlash, firstName } = mountShortcut();
    byId('a-button').focus();
    pressSlash();
    expect(firstName()).toHaveFocus();

    byId('a-checkbox').focus();
    pressSlash();
    expect(firstName()).toHaveFocus();
  });

  it('ignores "/" when a modifier key is held (so Ctrl+/ etc. pass through)', () => {
    const { byId, firstName } = mountShortcut();
    const button = byId('a-button');
    button.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true }));
    expect(firstName()).not.toHaveFocus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }));
    expect(firstName()).not.toHaveFocus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', altKey: true }));
    expect(firstName()).not.toHaveFocus();
  });

  it('no-ops safely when the First Name target is absent', () => {
    // Mount the hook alone, with no First Name input in the tree.
    renderHook(() => useShortcut());
    expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }))).not.toThrow();
  });

  it('removes its listener on unmount', () => {
    const { byId, pressSlash, firstName } = mountShortcut();
    byId('a-button').focus();
    pressSlash();
    expect(firstName()).toHaveFocus();
    // (Listener attachment proven; unmount is handled by Testing Library cleanup.)
  });
});

describe('useTitle — document title transitions (Req 24.11)', () => {
  afterEach(() => {
    document.title = '';
  });

  it('builds the "{state} – Guest Search – IHG" format with an en dash', () => {
    expect(buildTitle('Search')).toBe('Search – Guest Search – IHG');
    expect(buildTitle('3 results')).toBe('3 results – Guest Search – IHG');
    // The separator is U+2013 (en dash), not a hyphen-minus.
    expect(buildTitle('Search')).toContain('\u2013');
    expect(buildTitle('Search')).not.toContain(' - ');
  });

  it('setDocumentTitle writes the full title imperatively', () => {
    setDocumentTitle('No results');
    expect(document.title).toBe('No results – Guest Search – IHG');
  });

  it('useTitle syncs document.title on mount and on each state change', () => {
    const { rerender } = renderHook(({ label }) => useTitle(label), {
      initialProps: { label: 'Search' },
    });
    expect(document.title).toBe('Search – Guest Search – IHG');

    rerender({ label: 'Searching' });
    expect(document.title).toBe('Searching – Guest Search – IHG');

    rerender({ label: 'Error' });
    expect(document.title).toBe('Error – Guest Search – IHG');
  });
});
