import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const NO_ACCESS = { name: 'You do not have access to this page' };

const choosePatient = async (mrn: string) => {
  await userEvent.type(await screen.findByRole('combobox', { name: /^Patient/ }), mrn);
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(mrn) }));
};

const openForm = async () => {
  renderApp({ entry: '/admissions/new' });
  await screen.findByRole('heading', { name: 'Admit a patient', level: 1 });
  await screen.findAllByRole('radio');
};

const admitFirstDoctor = async () => {
  const doctor = await screen.findByRole('combobox', { name: /Admitting doctor/ });
  await waitFor(() => expect(within(doctor).getAllByRole('option').length).toBeGreaterThan(1));
  await userEvent.selectOptions(doctor, within(doctor).getAllByRole('option')[1] as HTMLElement);
};

describe('admitting a patient', () => {
  it('admits into a free bed, opens the stay and shows the admission in the list', async () => {
    await openForm();
    await choosePatient('MRN-PTH-00010');
    await admitFirstDoctor();
    await userEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await expectNoAxeViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Admit patient' }));
    expect(await screen.findByRole('heading', { name: 'Patient admitted' })).toHaveFocus();

    await userEvent.click(screen.getByRole('link', { name: 'Admissions' }));
    const grid = await screen.findByRole('table', { name: 'Admissions' });
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));
    expect(within(grid).getByText('Planned')).toBeInTheDocument();
  }, 20_000);

  it('does not admit without a bed', async () => {
    await openForm();
    await choosePatient('MRN-PTH-00010');
    await admitFirstDoctor();
    await userEvent.click(screen.getByRole('button', { name: 'Admit patient' }));
    expect(await screen.findByText('Choose a free bed.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Patient admitted' })).not.toBeInTheDocument();
  }, 20_000);

  it('says so and cannot admit when no bed is free', async () => {
    server.use(
      http.get('*/api/beds/board', () =>
        HttpResponse.json({ items: [], nextCursor: null, total: 0 }),
      ),
    );
    renderApp({ entry: '/admissions/new' });
    await screen.findByRole('heading', { name: 'Admit a patient', level: 1 });
    expect(await screen.findByText('No bed is free, so nobody can be admitted now.')).toBeVisible();
    await choosePatient('MRN-PTH-00010');
    await userEvent.click(screen.getByRole('button', { name: 'Admit patient' }));
    expect(await screen.findByText('Choose a free bed.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Patient admitted' })).not.toBeInTheDocument();
  }, 20_000);

  it('gives a bed to an admitted patient and moves them to another', async () => {
    await openForm();
    await choosePatient('MRN-PTH-00011');
    await admitFirstDoctor();
    await userEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Admit patient' }));
    await screen.findByRole('heading', { name: 'Patient admitted' });
    await userEvent.click(screen.getByRole('link', { name: 'Admissions' }));

    const grid = await screen.findByRole('table', { name: 'Admissions' });
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));
    await userEvent.click(within(grid).getByRole('button', { name: /Give or change bed/ }));
    const panel = await screen.findByRole('region', { name: /Move .* to another bed/ });
    await userEvent.click(within(panel).getAllByRole('radio')[0] as HTMLElement);
    await userEvent.click(within(panel).getByRole('button', { name: 'Move patient' }));
    expect(await screen.findByText(/is now in bed/)).toBeInTheDocument();
  }, 30_000);
});

describe('access to admitting', () => {
  it('offers no admit button without admission:create', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'admission:create');
    renderApp({ entry: '/admissions' });
    await screen.findByRole('heading', { name: 'Admissions', level: 1 });
    expect(screen.queryByRole('link', { name: 'Admit a patient' })).not.toBeInTheDocument();
  });

  it('closes the form without admission:create', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'admission:create');
    renderApp({ entry: '/admissions/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('offers no bed change without admission:transfer', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'admission:transfer');
    renderApp({ entry: '/admissions' });
    await screen.findByRole('heading', { name: 'Admissions', level: 1 });
    expect(screen.queryByRole('button', { name: /Give or change bed/ })).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'admissions', false);
    renderApp({ entry: '/admissions' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});
