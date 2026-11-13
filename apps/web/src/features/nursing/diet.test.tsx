import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { addMockDietOrder } from '@/mocks/handlers/nursing-diet';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const NO_ACCESS = { name: 'You do not have access to this page' };

beforeEach(() => {
  addMockAdmission({ id: 'adm_d1', patientName: 'Asha Verma', encounterId: 'enc_d1' });
  addMockAdmission({ id: 'adm_d2', patientName: 'Bina Rao', encounterId: 'enc_d2' });
  // The other hospital's stay must never show.
  addMockAdmission({
    id: 'adm_other',
    patientName: 'Other Hospital Patient',
    tenantId: TENANT_IDS.clinic,
    encounterId: 'enc_other',
  });
});

describe('the kitchen list', () => {
  const open = async () => {
    renderApp({ entry: '/nursing/kitchen' });
    await screen.findByRole('heading', { name: 'Kitchen list', level: 1 });
  };

  it('shows the diet each admitted patient is on, the latest order', async () => {
    addMockDietOrder({
      id: 'o1',
      encounterId: 'enc_d1',
      instructions: 'Soft diet',
      placedAt: '2026-11-08T08:00:00.000Z',
    });
    addMockDietOrder({
      id: 'o2',
      encounterId: 'enc_d1',
      instructions: 'Liquid diet, no salt',
      priority: 'urgent',
      placedAt: '2026-11-08T10:00:00.000Z',
    });
    await open();
    const grid = await screen.findByRole('table', { name: 'Kitchen list' });
    const asha = await within(grid).findByRole('row', { name: /Asha Verma/ });
    expect(asha).toHaveTextContent('Liquid diet, no salt');
    expect(asha).toHaveTextContent('Urgent');
    expect(asha).not.toHaveTextContent('Soft diet');
    expect(within(grid).getByRole('row', { name: /Bina Rao/ })).toHaveTextContent('No diet order');
    expect(within(grid).queryByText('Other Hospital Patient')).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('is unreachable without the permission or with the module off', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'order:read');
    renderApp({ entry: '/nursing/kitchen' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable with the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'nursing', false);
    renderApp({ entry: '/nursing/kitchen' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});

describe('diet orders of a stay', () => {
  const open = async () => {
    renderApp({ entry: '/nursing/adm_d1/diet' });
    await screen.findByRole('heading', { name: /Diet: Asha Verma/, level: 1 });
  };

  it('places a diet order, which becomes the current diet', async () => {
    addMockDietOrder({ id: 'o1', encounterId: 'enc_d1', instructions: 'Soft diet' });
    await open();
    await userEvent.type(
      screen.getByRole('textbox', { name: /Diet and instructions/ }),
      'Diabetic diet, no sugar',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Place diet order' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('The diet order was placed.'),
    );
    const grid = screen.getByRole('table', { name: 'Diet orders of the stay' });
    const row = await within(grid).findByRole('row', { name: /Diabetic diet/ });
    expect(row).toHaveTextContent('Current diet');
    expect(within(grid).getByRole('row', { name: /Soft diet/ })).not.toHaveTextContent(
      'Current diet',
    );
  }, 30_000);

  it('refuses an empty order', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Place diet order' }));
    expect(await screen.findByText(/Enter the diet/)).toBeInTheDocument();
  });

  it('has no way to place one without order:create', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'order:create');
    addMockDietOrder({ id: 'o1', encounterId: 'enc_d1', instructions: 'Soft diet' });
    await open();
    expect(await screen.findByText('Soft diet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Place diet order' })).not.toBeInTheDocument();
  });

  it('is offered from the ward worklist', async () => {
    renderApp({ entry: '/nursing' });
    const link = await screen.findByRole('link', { name: 'Kitchen list' });
    expect(link).toHaveAttribute('href', '/nursing/kitchen');
  });
});
