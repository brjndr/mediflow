import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { HomePage } from './HomePage';

// F-08 replaces this with routes generated from the feature registry.
export const routes: RouteObject[] = [{ path: '/', element: <HomePage /> }];

export function createRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(routes);
}
