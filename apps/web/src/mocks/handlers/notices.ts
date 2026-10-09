import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Notice = components['schemas']['Notice'];
type NoticePage = components['schemas']['NoticePage'];

const FEATURE_FLAG = 'notices';
const DAY_MS = 86_400_000;
const NEWEST = Date.parse('2026-10-01T04:30:00Z');

/** Synthetic notices. The hospital has more than one page, so pagination is exercised. */
function seed(): Notice[] {
  const build = (tenantId: string, prefix: string, count: number, topic: string): Notice[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}_${String(index + 1).padStart(2, '0')}`,
      tenantId,
      title: `${topic} ${index + 1}`,
      body: `Sample notice ${index + 1} for staff. This is synthetic data.`,
      createdAt: new Date(NEWEST - index * DAY_MS).toISOString(),
      archived: false,
    }));
  return [
    ...build(TENANT_IDS.hospital, 'ntc_h', 30, 'Hospital notice'),
    ...build(TENANT_IDS.clinic, 'ntc_c', 2, 'Clinic notice'),
  ];
}

let notices = seed();
onMockReset(() => {
  notices = seed();
});

export const noticesHandlers = [
  http.get('*/api/notices', ({ request }) => {
    const access = authorize(request, { permission: 'notice:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 100);
    const cursor = url.searchParams.get('cursor');
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = notices.filter((n) => n.tenantId === access.tenantId && !n.archived);
    const start = cursor ? visible.findIndex((n) => n.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const items = visible.slice(start, start + limit);
    const next = visible[start + limit];
    return HttpResponse.json<NoticePage>({
      items,
      nextCursor: next?.id ?? null,
      total: visible.length,
    });
  }),

  http.post('*/api/notices/:noticeId/archive', ({ request, params }) => {
    const access = authorize(request, { permission: 'notice:manage', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;

    // A notice of another hospital does not exist as far as this session is concerned.
    const notice = notices.find((n) => n.id === params.noticeId && n.tenantId === access.tenantId);
    if (!notice) return error(404, 'notice_not_found', 'No such notice');
    // Archiving twice is harmless, so a retried request cannot fail or duplicate anything.
    notice.archived = true;
    return HttpResponse.json<Notice>(notice);
  }),
];
