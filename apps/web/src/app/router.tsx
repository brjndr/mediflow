import { createBrowserRouter } from 'react-router-dom';
import type { Registry } from '@/registry';
import { createRoutes } from '@/routes';

export function createRouter(registry: Registry): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(createRoutes(registry));
}
