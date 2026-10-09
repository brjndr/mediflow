import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './app/AppProviders';
import { createI18n } from './app/i18n';
import { createQueryClient } from './app/query-client';
import { createRouter } from './app/router';
import { createStore } from './app/store';
import { appRegistry } from './registry';
import './index.css';

async function enableMocking() {
  // The mock backend runs only in dev, or when explicitly enabled for a preview build (e2e).
  if (import.meta.env.VITE_API_MOCKING === 'disabled') return;
  if (!import.meta.env.DEV && import.meta.env.VITE_API_MOCKING !== 'enabled') return;
  const { worker } = await import('./mocks/browser');
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
}

void enableMocking().then(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Root element missing');
  createRoot(root).render(
    <StrictMode>
      <AppProviders
        client={createQueryClient()}
        store={createStore()}
        i18n={createI18n()}
        registry={appRegistry}
      >
        <RouterProvider router={createRouter(appRegistry)} />
      </AppProviders>
    </StrictMode>,
  );
});
