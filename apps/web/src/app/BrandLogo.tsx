// BrandLogo renders the IHG brand mark through a single component (Req 23.6).
//
// It loads the official logo from the app's brand-assets path (/brand/ihg-logo.svg)
// when present, and otherwise renders an accessible text wordmark. Until IHG Brand
// supplies the official file (Blocker B8), the wordmark is what renders - the <img>
// falls back on error. We never scrape ihg.com or use aggregator logos (Req 23.7).
import { useState } from 'react';

const LOGO_SRC = '/brand/ihg-logo.svg';

export function BrandLogo() {
  const [failed, setFailed] = useState(false);

  if (failed) {
    // Text wordmark placeholder. aria-hidden on the decorative mark; the
    // accessible name for the brand is carried by the header heading.
    return (
      <span
        className="inline-flex h-9 items-center rounded-control bg-navy px-2.5 text-lg font-extrabold tracking-tight text-surface"
        aria-hidden="true"
      >
        IHG
      </span>
    );
  }

  return <img src={LOGO_SRC} alt="IHG" className="h-8 w-auto" onError={() => setFailed(true)} />;
}
