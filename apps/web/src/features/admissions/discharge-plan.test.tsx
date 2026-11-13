import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { openClearances, type DischargePlan } from './types';

const openPanel = async () => {
  addMockAdmission({ id: 'adm_plan', status: 'admitted', version: 1 });
  renderApp({ entry: '/admissions' });
  const grid = await screen.findByRole('table', { name: 'Admissions' });
  await userEvent.click(await within(grid).findByRole('button', { name: /Discharge/ }));
  return screen.findByRole('region', { name: /Discharge / });
};

const submit = (panel: HTMLElement) =>
  within(panel).getByRole('button', { name: 'Discharge patient' });

describe('openClearances', () => {
  const plan: DischargePlan = {
    admissionId: 'a',
    version: 1,
    clearances: [
      { kind: 'nursing', status: 'cleared' },
      { kind: 'pharmacy', status: 'pending' },
      { kind: 'lab', status: 'pending' },
    ],
  };

  it('lists what the way of leaving needs and is not cleared', () => {
    expect(openClearances(plan, 'routine')).toEqual(['pharmacy', 'lab']);
    expect(openClearances(plan, 'against_advice')).toEqual(['pharmacy']);
    expect(openClearances(plan, 'absconded')).toEqual([]);
  });
});

describe('the discharge plan', () => {
  it('holds the discharge until each required clearance is done', async () => {
    const panel = await openPanel();
    expect(await within(panel).findByTestId('clearance-gate')).toHaveTextContent(
      /Nursing.*Pharmacy.*Laboratory/,
    );
    expect(submit(panel)).toHaveAttribute('aria-disabled', 'true');
    await expectNoAxeViolations();

    for (const kind of [
      'Nursing',
      'Pharmacy (medicines to return)',
      'Laboratory (pending tests)',
    ]) {
      await userEvent.click(within(panel).getByRole('button', { name: `Mark ${kind} cleared` }));
      await within(panel).findByRole('button', { name: `Reopen ${kind}` });
    }
    await waitFor(() => expect(within(panel).queryByTestId('clearance-gate')).toBeNull());
    expect(submit(panel)).not.toHaveAttribute('aria-disabled');

    await userEvent.click(submit(panel));
    expect(await screen.findByText(/is discharged\. The bed is being cleaned/)).toBeInTheDocument();
  }, 30_000);

  it('needs fewer clearances against advice and none for one who absconded', async () => {
    const panel = await openPanel();
    const how = await within(panel).findByRole('combobox', { name: 'How the stay ends' });
    await userEvent.selectOptions(how, 'against_advice');
    expect(await within(panel).findByTestId('clearance-gate')).not.toHaveTextContent(/Laboratory/);
    await userEvent.selectOptions(how, 'absconded');
    await waitFor(() => expect(within(panel).queryByTestId('clearance-gate')).toBeNull());
    expect(submit(panel)).not.toHaveAttribute('aria-disabled');
  }, 30_000);

  it('saves the advice', async () => {
    const panel = await openPanel();
    await userEvent.type(
      await within(panel).findByRole('textbox', { name: 'Advice for the patient' }),
      'Rest',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Save advice' }));
    expect(await within(panel).findByText('Advice saved.')).toBeInTheDocument();
  }, 30_000);

  it('does not let someone without the clearance permissions clear anything', async () => {
    for (const permission of ['Nursing', 'Pharmacy', 'Lab']) {
      revokePermission(TENANT_IDS.hospital, 'admin', `discharge:clear${permission}`);
    }
    const panel = await openPanel();
    await within(panel).findByTestId('clearance-gate');
    expect(within(panel).queryByRole('button', { name: /^Mark .* cleared$/ })).toBeNull();
    expect(submit(panel)).toHaveAttribute('aria-disabled', 'true');
  }, 30_000);

  it('shows no plan and gates nothing when the API has none', async () => {
    server.use(
      http.get('*/api/admissions/:admissionId/discharge-plan', () =>
        HttpResponse.json({ code: 'not_found', message: 'No' }, { status: 404 }),
      ),
    );
    const panel = await openPanel();
    await waitFor(() => expect(within(panel).queryByText('Checking the bill…')).toBeNull());
    expect(within(panel).queryByTestId('discharge-plan')).toBeNull();
    expect(submit(panel)).not.toHaveAttribute('aria-disabled');
  }, 30_000);

  it('is out of reach for a hospital without the admissions module, and its plan is not read', async () => {
    addMockAdmission({ id: 'adm_other', status: 'admitted', version: 1 });
    signIn(USER_IDS.admin, TENANT_IDS.clinic);
    renderApp({ entry: '/admissions' });
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Admissions' })).toBeNull());
    expect(screen.queryByRole('region', { name: /Discharge / })).toBeNull();
  }, 30_000);
});
