// Shared test providers. The results table and drawer now use a React Query mutation for
// the reveal flow (task 12.7), so component-level tests that render them directly must
// supply a QueryClient alongside the always-mounted StatusRegion.
import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { StatusRegionProvider } from '../../src/a11y/StatusRegion';
import { createQueryClient } from '../../src/app/queryClient';
import type { RevealMap } from '../../src/features/results/useReveal';

/** Wrap children in a fresh QueryClient (once per mount) and the StatusRegion provider. */
export function TestProviders({ children }: { children: ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <StatusRegionProvider>{children}</StatusRegionProvider>
    </QueryClientProvider>
  );
}

/** A reveal store that holds nothing — for tables rendered with canReveal={false}. */
export function emptyRevealMap(): RevealMap {
  return {
    get: () => undefined,
    set: () => undefined,
    clear: () => undefined,
  };
}
