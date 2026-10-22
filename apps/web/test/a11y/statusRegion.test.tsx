// StatusRegion tests (task 12.8, Req 24.9).
//
// The provider owns the single polite live region used for non-error announcements.
// Its announce() debounces bursts and briefly clears the node before writing, so screen
// readers re-announce even an identical message. The pagination/search suites observe
// the region indirectly; here we pin the debounce behaviour directly with fake timers:
//   - a single announce writes the message after the debounce + clear delay;
//   - a burst coalesces to the LAST message (earlier ones never appear);
//   - re-announcing the same string clears then re-sets it (so AT repeats it);
//   - using the hook outside the provider throws (a wiring guard).
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusRegionProvider, useStatusRegion } from '../../src/a11y/StatusRegion';

/** Render a bare provider and return the always-mounted status node plus announce(). */
function setup() {
  let announce!: (msg: string) => void;
  function Probe() {
    announce = useStatusRegion().announce;
    return null;
  }
  render(
    <StatusRegionProvider>
      <Probe />
    </StatusRegionProvider>,
  );
  return { announce, region: screen.getByRole('status') };
}

describe('StatusRegion debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('writes a single message after the debounce and clear delays', () => {
    const { announce, region } = setup();
    act(() => announce('2 guests found'));

    // Nothing yet: the 150ms debounce has not elapsed.
    expect(region).toHaveTextContent('');
    act(() => vi.advanceTimersByTime(150));
    // Debounce fired: the node was cleared, the set is scheduled 50ms later.
    expect(region).toHaveTextContent('');
    act(() => vi.advanceTimersByTime(50));
    expect(region).toHaveTextContent('2 guests found');
  });

  it('coalesces a burst of announcements to the last one only', () => {
    const { announce, region } = setup();
    act(() => {
      announce('first');
      announce('second');
      announce('third');
    });
    act(() => vi.advanceTimersByTime(150 + 50));
    // Only the final message survives the debounce window.
    expect(region).toHaveTextContent('third');
    expect(region).not.toHaveTextContent('first');
    expect(region).not.toHaveTextContent('second');
  });

  it('re-announces an identical message by clearing then re-setting the node', () => {
    const { announce, region } = setup();
    act(() => announce('2 guests found'));
    act(() => vi.advanceTimersByTime(200));
    expect(region).toHaveTextContent('2 guests found');

    // Announce the same text again.
    act(() => announce('2 guests found'));
    // The debounce clears the node first (so AT sees a change), …
    act(() => vi.advanceTimersByTime(150));
    expect(region).toHaveTextContent('');
    // … then re-writes the identical message.
    act(() => vi.advanceTimersByTime(50));
    expect(region).toHaveTextContent('2 guests found');
  });

  it('is a polite, atomic, visually-hidden region', () => {
    const { region } = setup();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveClass('sr-only');
  });
});

describe('useStatusRegion guard', () => {
  it('throws when used outside a StatusRegionProvider', () => {
    // Silence the expected React error boundary console noise for this one assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useStatusRegion())).toThrow(/within a StatusRegionProvider/);
    spy.mockRestore();
  });
});
