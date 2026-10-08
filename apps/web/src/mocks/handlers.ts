import { http, HttpResponse } from 'msw';
import type { Health } from '@/shared/api/health';

// F-04 adds session, switch-tenant and policy handlers with two sample hospitals.
export const handlers = [
  http.get('*/api/health', () => HttpResponse.json<Health>({ status: 'ok' })),
];
