import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { addMockQueueToken } from '@/mocks/handlers/queue';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Waiting-room display', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const LIVE = 'Live: changes show within seconds.';

const open = async () => {
  const app = renderApp({ entry: '/queue/display' });
  await screen.findByRole('heading', HEADING);
  await screen.findByText(LIVE);
  return app;
};

describe('the waiting-room display', () => {
  it('shows each department’s token being served with its doctor, and the numbers next', async () => {
    await open();
    const department = await screen.findByRole('region', { name: 'Anaesthesiology' });
    expect(within(department).getByText('Token 1')).toBeInTheDocument();
    expect(within(department).getByText('Aarav Sharma')).toBeInTheDocument();
    // A priority first, then in the order issued.
    const next = within(department).getByRole('heading', { name: 'Next' }).nextElementSibling;
    expect(
      within(next as HTMLElement)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['4', '2', '3']);
    expect(within(department).getByText('3 waiting')).toBeInTheDocument();
  });

  it('holds no patient: no name, MRN or reason is on the page', async () => {
    const { container } = await open();
    await screen.findByRole('region', { name: 'Anaesthesiology' });
    const text = container.ownerDocument.body.textContent ?? '';
    for (const word of ['MRN', 'pregnancy', 'senior', 'Asha', 'Verma']) {
      expect(text).not.toContain(word);
    }
    await expectNoAxeViolations(container);
  });

  it('shows a token issued at another desk within seconds', async () => {
    await open();
    const department = await screen.findByRole('region', { name: 'Anaesthesiology' });
    expect(within(department).getByText('3 waiting')).toBeInTheDocument();
    addMockQueueToken({
      id: 'qt_display_late',
      tenantId: TENANT_IDS.hospital,
      departmentId: 'dep_h_01',
      patientId: 'pth_00990',
      status: 'waiting',
      issuedAt: new Date().toISOString(),
      callCount: 0,
      version: 1,
    });
    await waitFor(() => expect(within(department).getByText('4 waiting')).toBeInTheDocument());
  });

  it('is reached from the board', async () => {
    renderApp({ entry: '/queue' });
    const link = await screen.findByRole('link', { name: 'Waiting-room display' });
    expect(link).toHaveAttribute('href', '/queue/display');
  });
});

describe('access', () => {
  it('opens to a custom role given queue:read', async () => {
    signIn(USER_IDS.billingClerk);
    grantPermission(TENANT_IDS.clinic, 'billing_clerk', 'queue:read');
    renderApp({ entry: '/queue/display' });
    expect(await screen.findByText('2 waiting')).toBeInTheDocument();
  });

  it('is not open without queue:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'queue:read');
    renderApp({ entry: '/queue/display' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable with the queue switched off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'queue', false);
    renderApp({ entry: '/queue/display' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('shows the other hospital its own numbers only', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/queue/display' });
    const department = await screen.findByRole('region', { name: /./ });
    expect(within(department).getByText('2 waiting')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Anaesthesiology' })).not.toBeInTheDocument();
  });
});
