// BrandLogo tests (task 12.8 gap-fill, Req 23.6 / 23.7).
//
// BrandLogo loads /brand/ihg-logo.svg and falls back to an accessible text wordmark when
// the image fails to load (Blocker B8: the official file is not supplied yet, so the
// error path is the common one in dev). The shell tests render the header but never
// trigger the <img> onError, leaving the fallback branch unproven; this pins it.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrandLogo } from '../../src/app/BrandLogo';

describe('BrandLogo', () => {
  it('renders the official logo image by default', () => {
    render(<BrandLogo />);
    const img = screen.getByRole('img', { name: 'IHG' });
    expect(img).toHaveAttribute('src', '/brand/ihg-logo.svg');
  });

  it('falls back to the text wordmark when the image fails to load (Req 23.6)', () => {
    render(<BrandLogo />);
    const img = screen.getByRole('img', { name: 'IHG' });
    fireEvent.error(img);

    // The <img> is replaced by the decorative wordmark; the img role is gone.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const wordmark = screen.getByText('IHG');
    expect(wordmark).toHaveAttribute('aria-hidden', 'true');
  });
});
