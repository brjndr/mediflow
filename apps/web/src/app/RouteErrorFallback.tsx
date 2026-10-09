import { useEffect } from 'react';
import { useRouteError } from 'react-router-dom';
import { ErrorFallback } from './ErrorFallback';
import { reportError } from './observability';

/** The router's errorElement: reports what the route threw, then shows the generic fallback. */
export function RouteErrorFallback() {
  const error = useRouteError();
  useEffect(() => {
    reportError(error);
  }, [error]);
  return <ErrorFallback />;
}
