import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { HomePage } from './HomePage';

describe('HomePage', () => {
  it('shows the API status from the mock backend', async () => {
    renderWithProviders(<HomePage />);
    expect(await screen.findByText('ok')).toBeInTheDocument();
  });

  it('shows unreachable when the API fails', async () => {
    server.use(http.get('*/api/health', () => new HttpResponse(null, { status: 503 })));
    renderWithProviders(<HomePage />);
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
  });
});
