// buildUiConfig (task 8.4; Req 3.4, 3.5, 9.4, 15.6): the non-sensitive config the UI reads.
import { describe, expect, it } from 'vitest';

import { buildUiConfig, type UiConfigSource } from '../../../src/services/uiConfig.js';

function source(overrides: Partial<UiConfigSource> = {}): UiConfigSource {
  return {
    ui: {
      scoreBands: { high: 90, medium: 70 },
      memberTypes: [
        { code: 'PC', label: 'Platinum' },
        { code: 'GC', label: 'Gold' },
      ],
    },
    soap: {
      // Only the three feature flags are read; the rest of soap config is irrelevant here.
      features: { addressLine1: true, city: false, postalCode: true },
    } as UiConfigSource['soap'],
    auth: { mode: 'dev' },
    ...overrides,
  };
}

describe('buildUiConfig', () => {
  it('projects score bands, member types, feature flags and auth mode', () => {
    expect(buildUiConfig(source())).toEqual({
      scoreBands: { high: 90, medium: 70 },
      memberTypes: [
        { code: 'PC', label: 'Platinum' },
        { code: 'GC', label: 'Gold' },
      ],
      features: { addressLine1: true, city: false, postalCode: true },
      authMode: 'dev',
    });
  });

  it('reflects the oidc auth mode', () => {
    expect(buildUiConfig(source({ auth: { mode: 'oidc' } })).authMode).toBe('oidc');
  });

  it('returns copies of member types so the loaded config cannot be mutated', () => {
    const src = source();
    const ui = buildUiConfig(src);
    ui.memberTypes[0]!.label = 'MUTATED';
    expect(src.ui.memberTypes[0]?.label).toBe('Platinum');
  });

  it('exposes none of the sensitive SOAP config (endpoint, headers, secrets)', () => {
    const ui = buildUiConfig(source());
    const serialized = JSON.stringify(ui);
    expect(serialized).not.toContain('endpoint');
    expect(serialized).not.toContain('serviceUser');
    expect(serialized).not.toContain('credential');
    expect(Object.keys(ui).sort()).toEqual(['authMode', 'features', 'memberTypes', 'scoreBands']);
  });
});
