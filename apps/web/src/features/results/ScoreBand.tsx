// ScoreBand: the match-score band chip shown next to each numeric score (Req 15.6).
//
// The band is conveyed in TEXT ("High" / "Medium" / "Low") and with a distinct SHAPE
// icon, never by colour alone (Req 24.5, ihg-brand-ui rule). Colours come only from
// brand tokens (no hex); the icon is decorative (aria-hidden) because the band word is
// the accessible content. A missing score renders no chip — the cell shows the empty
// indicator instead, handled by the caller.
import { scoreBand, SCORE_BAND_LABEL, type ScoreBand as Band } from '../../lib/format.js';
import type { UiConfig } from '@ihg-guest-search/shared';

interface ScoreBandChipProps {
  score: number | undefined;
  bands: UiConfig['scoreBands'];
}

/**
 * A decorative shape per band so the three bands are distinguishable without colour
 * (filled circle / half circle / ring). Rendered as inline SVG so it scales with text.
 */
function BandIcon({ band }: { band: Band }) {
  // Shared stroke/fill use currentColor so the icon inherits the chip's token colour.
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true } as const;
  switch (band) {
    case 'high':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
      );
    case 'medium':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1 A5 5 0 0 1 6 11 Z" fill="currentColor" />
        </svg>
      );
    case 'low':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

/** Token-backed colour per band. All three meet AA contrast on the chip's wash. */
const BAND_CLASS: Record<Band, string> = {
  high: 'bg-navy-wash text-navy',
  medium: 'bg-surface-2 text-body',
  low: 'bg-surface-2 text-muted',
};

export function ScoreBandChip({ score, bands }: ScoreBandChipProps) {
  const band = scoreBand(score, bands);
  if (band === undefined) return null;
  const label = SCORE_BAND_LABEL[band];
  return (
    <span
      data-testid="score-band"
      data-band={band}
      className={`inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-xs font-semibold ${BAND_CLASS[band]}`}
    >
      <BandIcon band={band} />
      {label} match
    </span>
  );
}
