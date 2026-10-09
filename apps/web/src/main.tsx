import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './app/AppProviders';
import { createI18n } from './app/i18n';
import { createQueryClient } from './app/query-client';
import { createRouter } from './app/router';
import { sessionKey, type Session } from './app/session';
import { createStore } from './app/store';
import { appRegistry } from './registry';
import { env } from './shared/config/env';
import { logger } from './shared/lib/logger';
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

  const queryClient = createQueryClient();
  const router = createRouter(appRegistry);
  const i18n = createI18n({
    features: appRegistry.translations,
    onMissingKey: import.meta.env.DEV
      ? (key) => logger.warn('i18n.missing_key', { key })
      : undefined,
  });

  createRoot(root).render(
    <StrictMode>
      <AppProviders client={queryClient} store={createStore()} i18n={i18n} registry={appRegistry}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );

  // Non-critical code loads after first paint, when the browser is idle (CLAUDE.md Build).
  const whenIdle =
    window.requestIdleCallback ?? ((callback: () => void) => setTimeout(callback, 1));
  whenIdle(() => {
    const getTenantId = () =>
      queryClient.getQueryData<Session | null>(sessionKey)?.activeTenant?.id;
    void Promise.all([
      import('./app/observability/web-vitals'),
      import('./app/observability/error-reporting'),
    ]).then(([{ startWebVitals, routePattern, discardVitals }, { startErrorReporting }]) => {
      const getRoute = () => routePattern(router.state.matches);
      void startWebVitals({ getRoute, getTenantId, sink: discardVitals });
      // Does nothing, and downloads nothing, unless a DSN is configured for this deployment.
      void startErrorReporting({
        dsn: env.sentryDsn,
        environment: import.meta.env.MODE,
        getContext: () => ({ route: getRoute(), tenantId: getTenantId() }),
      });
    });
  });
});
