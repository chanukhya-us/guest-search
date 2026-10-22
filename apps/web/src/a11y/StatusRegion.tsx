// StatusRegion: the single polite live region for status announcements (Req 24.9).
//
// design.md: "Only StatusRegion (role=status) is used for non-errors." Errors use
// role="alert" elsewhere, so a message is never announced by both mechanisms. The
// region is always mounted (so assistive tech is already observing it) and visually
// hidden. announce() debounces rapid updates and briefly clears the node before
// writing, which makes screen readers re-announce an identical message (e.g. two
// searches that both return "2 guests found").
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface StatusRegionValue {
  /** Announce a polite status message to assistive technology. */
  announce: (message: string) => void;
}

const StatusRegionContext = createContext<StatusRegionValue | null>(null);

/** Debounce window: coalesce bursts of announcements into the last one (ms). */
const DEBOUNCE_MS = 150;

export function StatusRegionProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((next: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Clear then set so an identical message is re-announced.
      setMessage('');
      if (clearRef.current) clearTimeout(clearRef.current);
      clearRef.current = setTimeout(() => setMessage(next), 50);
    }, DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (clearRef.current) clearTimeout(clearRef.current);
    },
    [],
  );

  const value = useMemo<StatusRegionValue>(() => ({ announce }), [announce]);

  return (
    <StatusRegionContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </StatusRegionContext.Provider>
  );
}

/** Access announce(). Throws if used outside the provider (a wiring bug, not runtime). */
export function useStatusRegion(): StatusRegionValue {
  const ctx = useContext(StatusRegionContext);
  if (ctx === null) {
    throw new Error('useStatusRegion must be used within a StatusRegionProvider');
  }
  return ctx;
}
