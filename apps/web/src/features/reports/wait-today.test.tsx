import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The wait widget (#1125), from the `opd_wait` report. The mock's hospital: 40 consultations
// started, 12 minutes in Cardiology, 20 in General Medicine and 8 in Orthopaedics at 9, 12 and 31
// minutes, so 15 on average, and 7 tokens not yet seen. The clinic: 6 minutes, 1 not yet seen.

const WAIT = 'Average wait today';
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });

async function widget() {
  const region = await screen.findByRole('region', { name: WAIT });
  await within(region).findByText('Token to consultation');
  return region;
}

describe('the wait widget', () => {
  it('shows the average over every department and the longest wait', async () => {
    signIn(USER_IDS.admin);
    const { container } = renderApp();
    await home();
    const region = await widget();

    expect(within(region).getByText('15 minutes')).toBeInTheDocument();
    expect(within(region).getByText('Median over all departments: 11 minutes')).toBeInTheDocument();
    expect(within(region).getByText('Longest wait: Orthopaedics, 31 minutes')).toBeInTheDocument();
    expect(within(region).getByText('7 not yet seen')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('gives another hospital its own figures', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'reports', true);
    grantPermission(TENANT_IDS.clinic, 'doctor', 'report:read');
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp();
    await home();
    const region = await widget();

    expect(within(region).getByText('6 minutes')).toBeInTheDocument();
    expect(
      within(region).getByText('Longest wait: General Medicine, 6 minutes'),
    ).toBeInTheDocument();
    expect(within(region).getByText('1 not yet seen')).toBeInTheDocument();
  });

  it('says so when no consultation has started', async () => {
    server.use(
      http.post('*/api/reports/opd_wait', async ({ request }) => {
        const body = (await request.json()) as { from: string; to: string };
        return HttpResponse.json({
          kind: 'opd_wait',
          from: body.from,
          to: body.to,
          currency: 'INR',
          generatedAt: new Date().toISOString(),
          columns: [
            { key: 'day', type: 'date' },
            { key: 'department', type: 'text' },
            { key: 'started', type: 'integer' },
            { key: 'avgWaitMinutes', type: 'minutes' },
            { key: 'medianWaitMinutes', type: 'minutes' },
            { key: 'notStarted', type: 'integer' },
            { key: 'dayMedianWaitMinutes', type: 'minutes' },
          ],
          rows: [[body.to, 'Cardiology', 0, null, null, 3, null]],
          totals: [null, null, 0, null, null, 3, null],
        });
      }),
    );
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: WAIT });
    expect(
      await within(region).findByText('No consultations started yet today.'),
    ).toBeInTheDocument();
  });

  it('says so in place when the report fails', async () => {
    server.use(
      http.post('*/api/reports/opd_wait', () =>
        HttpResponse.json({ code: 'server_error' }, { status: 500 }),
      ),
    );
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    const region = await screen.findByRole('region', { name: WAIT });
    expect(await within(region).findByRole('alert')).toBeInTheDocument();
  });

  it('is left out without report:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'report:read');
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(screen.queryByRole('region', { name: WAIT })).not.toBeInTheDocument();
  });

  it('is left out when the reports module is off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'reports', false);
    signIn(USER_IDS.admin);
    renderApp();
    await home();
    expect(screen.queryByRole('region', { name: WAIT })).not.toBeInTheDocument();
  });
});
