// Web test setup (jsdom). Registers @testing-library/jest-dom matchers (toBeInTheDocument,
// toHaveAttribute, …) and tears down the DOM between tests so renders stay isolated.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
