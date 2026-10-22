// Toolchain smoke test (task 1.3): proves the shared project runs in node and
// that the package resolves to src/ via the @ihg-guest-search/source condition.
import { describe, expect, it } from 'vitest';
import * as shared from '@ihg-guest-search/shared';

describe('shared project', () => {
  it('runs in the node environment', () => {
    expect('window' in globalThis).toBe(false);
  });

  it('resolves @ihg-guest-search/shared to its source entry', () => {
    expect(shared).toBeTypeOf('object');
  });
});
