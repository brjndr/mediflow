import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/node';
import { renderApp } from '@/test/render';

// #1107: the earlier exports name what each was filtered by.
const run = (id: string, filters?: object) => ({
  id,
  kind: 'audit_log',
  from: '2026-11-01',
  to: '2026-11-07',
  status: 'succeeded',
  requestedBy: { id: 'u-1', name: 'Asha' },
  requestedAt: '2026-11-08T05:00:00Z',
  expiresAt: '2026-12-08T05:00:00Z',
  rowCount: 3,
  ...(filters ? { filters } : {}),
});

describe('the earlier exports', () => {
  it('say what each was filtered by, and when it was not', async () => {
    server.use(
      http.get('*/api/reports/runs', () =>
        HttpResponse.json({
          items: [
            run('a', { actorId: 'u-2', actorName: 'Meera', entity: 'patient', action: 'read' }),
            run('b'),
            { ...run('c'), kind: 'revenue' },
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp({ entry: '/audit-log' });
    const table = await screen.findByRole('table', { name: 'Earlier exports' });
    expect(
      await within(table).findByText('Person: Meera; Record type: patient; Action: read'),
    ).toBeInTheDocument();
    expect(within(table).getByText('Nothing: the whole log for these days')).toBeInTheDocument();
    // The revenue run is not an audit export.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });
});
