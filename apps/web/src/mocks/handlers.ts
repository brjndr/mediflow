import { http, HttpResponse } from 'msw';
import type { Health } from '@/shared/api/health';
import { sampleSession } from './fixtures';

// F-04 adds switch-tenant and policy handlers with two sample hospitals.
export const handlers = [
  http.get('*/api/health', () => HttpResponse.json<Health>({ status: 'ok' })),
  // The mock is always signed in until login exists (A-01).
  http.get('*/api/session', () => HttpResponse.json(sampleSession)),
];
