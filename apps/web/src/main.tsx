// SPA entry point. Imports the global brand stylesheet and mounts React 19.
// <App/> provides QueryClientProvider and the StatusRegion provider (see App.tsx).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
