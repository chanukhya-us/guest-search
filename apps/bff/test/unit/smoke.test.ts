// Toolchain smoke test (task 1.3): proves the bff project runs in node and can
// import the shared package from source.
import { describe, expect, it } from 'vitest';
import * as shared from '@ihg-guest-search/shared';

describe('bff project', () => {
  it('runs in the node environment', () => {
    expect('window' in globalThis).toBe(false);
    expect(typeof process.versions.node).toBe('string');
  });

  it('resolves @ihg-guest-search/shared', () => {
    expect(shared).toBeTypeOf('object');
  });
});
