// Toolchain smoke test (task 1.3): proves the web project runs in jsdom and can
// import the shared package from source.
import { describe, expect, it } from 'vitest';
import * as shared from '@ihg-guest-search/shared';

describe('web project', () => {
  it('runs in the jsdom environment', () => {
    const el = document.createElement('p');
    el.textContent = 'ok';
    document.body.append(el);
    expect(document.body.textContent).toBe('ok');
  });

  it('resolves @ihg-guest-search/shared', () => {
    expect(shared).toBeTypeOf('object');
  });
});
