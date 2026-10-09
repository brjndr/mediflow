import { screen } from '@testing-library/react';
import { RequireSession } from '@/routes/session-guards';
import { renderApp } from '@/test/render';
import { AppShell } from './AppShell';
import { ErrorFallback } from './ErrorFallback';

describe('AppShell', () => {
  it('renders the shell around the lazy home route', async () => {
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Hospital management system' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Mediflow');
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('api-status'));
  });

  it('shows the error fallback when a route fails to render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('boom');
    }
    renderApp({
      routes: [
        {
          path: '/',
          element: (
            <RequireSession>
              <AppShell />
            </RequireSession>
          ),
          errorElement: <ErrorFallback />,
          children: [{ index: true, element: <Broken /> }],
        },
      ],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });
});
