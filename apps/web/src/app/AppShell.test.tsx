import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { routes } from '@/routes';
import { createTestQueryClient } from '@/test/render';
import { AppProviders } from './AppProviders';
import { AppShell } from './AppShell';
import { ErrorFallback } from './ErrorFallback';
import { createI18n } from './i18n';
import { createStore } from './store';

function renderApp(routeObjects: RouteObject[]) {
  return render(
    <AppProviders client={createTestQueryClient()} store={createStore()} i18n={createI18n()}>
      <RouterProvider router={createMemoryRouter(routeObjects, { initialEntries: ['/'] })} />
    </AppProviders>,
  );
}

describe('AppShell', () => {
  it('renders the shell around the lazy home route', async () => {
    renderApp(routes);
    expect(screen.getByRole('banner')).toHaveTextContent('Mediflow');
    expect(
      await screen.findByRole('heading', { name: 'Hospital management system' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('api-status'));
  });

  it('shows the error fallback when a route fails to render', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('boom');
    }
    renderApp([
      {
        path: '/',
        element: <AppShell />,
        errorElement: <ErrorFallback />,
        children: [{ index: true, element: <Broken /> }],
      },
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });
});
