// Root application component (design.md "apps/web — structure").
//
// Composes the app-wide providers around the shell:
//   - QueryClientProvider: the single React Query client (gcTime 5 min, retry false),
//     which backs useMe / useUiConfig and the search/reveal mutations.
//   - StatusRegionProvider: the always-mounted polite live region (Req 24.9).
//
// Keeping the providers here (rather than only in main.tsx) makes <App/> self-contained,
// so tests can render it and inject an isolated QueryClient.
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { StatusRegionProvider } from './a11y/StatusRegion.js';
import { AppShell } from './app/AppShell.js';
import { createQueryClient } from './app/queryClient.js';

interface AppProps {
  /** Injectable for tests; defaults to a fresh client in production. */
  queryClient?: QueryClient;
}

export function App({ queryClient }: AppProps = {}) {
  // Lazy-init so the client is created once per mount, not on every render.
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <StatusRegionProvider>
        <AppShell />
      </StatusRegionProvider>
    </QueryClientProvider>
  );
}
