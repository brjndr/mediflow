import { createBrowserRouter } from 'react-router-dom';
import { routes } from '@/routes';

export function createRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(routes);
}
