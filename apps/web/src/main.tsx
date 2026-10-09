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
    // Translation keys are not patient data, so a missing one is safe to report in dev.
    onMissingKey: import.meta.env.DEV
      ? (key) => console.warn(`Missing translation: ${key}`)
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
    void import('./app/observability/web-vitals').then(
      ({ startWebVitals, routePattern, discardVitals }) =>
        startWebVitals({
          getRoute: () => routePattern(router.state.matches),
          getTenantId: () => queryClient.getQueryData<Session | null>(sessionKey)?.activeTenant?.id,
          sink: discardVitals,
        }),
    );
  });
});
