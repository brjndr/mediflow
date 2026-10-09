import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';

function Broken(): never {
  throw new Error('MRN-TEST-00001 failed to render');
}

describe('GlobalErrorBoundary', () => {
  it('shows a friendly fallback without the error details', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWithProviders(<Broken />, { session: null });
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByText(/MRN-TEST-00001/)).not.toBeInTheDocument();
  });
});
