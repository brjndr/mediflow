import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { limitLevel, limitUsedPercent } from './coverage-schemas';

// Policy capture and pre-authorization (#182): the "Insurance" tab of the patient's screen and
// the cover panel of the invoice builder. The mock's first patient has a Gold policy and, for
// the open visit enc_h_1, an approved pre-authorization of 50,000.00 billed to 42,000.00.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

async function openTab(patient = 'pth_00001') {
  const app = renderApp({ entry: `/patients/${patient}?tab=insurance` });
  await screen.findByRole('tab', { name: 'Insurance', selected: true });
  return app;
}

describe('limit levels', () => {
  it('warns at 80 percent and says reached at the limit, never rounding up into a warning', () => {
    expect(limitUsedPercent(0, 0)).toBeNull();
    expect(limitLevel(7999, 10000)).toBe('ok');
    expect(limitLevel(8000, 10000)).toBe('near');
    expect(limitLevel(9999, 10000)).toBe('near');
    expect(limitLevel(10000, 10000)).toBe('reached');
    expect(limitLevel(12000, 10000)).toBe('reached');
    expect(limitLevel(1, 0)).toBe('reached');
  });
});

describe('the insurance tab', () => {
  it('lists the policy and the pre-authorization with its limit, and has no axe violations', async () => {
    await openTab();
    expect(await screen.findByText('Star Sample Insurance, Gold family floater')).toBeVisible();
    expect(screen.getByText('STAR-2026-0001')).toBeVisible();
    expect(
      screen.getByText('Planned knee replacement, 5 days in a semi-private room'),
    ).toBeVisible();
    expect(screen.getByText(/Approved: [^0-9]*50,000.00/i)).toBeVisible();
    expect(screen.getByText(/Billed so far: [^0-9]*42,000.00/i)).toBeVisible();
    await expectNoAxeViolations();
  });

  it('adds a policy with a plan of the chosen organisation', async () => {
    await openTab();
    await screen.findByText('STAR-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Add a policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an insurance policy' });
    const choose = within(dialog);
    await userEvent.click(choose.getByRole('button', { name: 'Save' }));
    expect(await choose.findAllByText(/required/i)).not.toHaveLength(0);

    await userEvent.selectOptions(
      await choose.findByRole('combobox', { name: /Insurer, TPA or corporate/ }),
      'pyr_h_star',
    );
    await userEvent.selectOptions(
      await choose.findByRole('combobox', { name: /^Plan/ }),
      'pln_h_gold',
    );
    await userEvent.type(choose.getByLabelText(/Policy number/), 'STAR-NEW-9');
    await userEvent.type(choose.getByLabelText(/Policy holder/), 'Second Holder');
    await userEvent.type(choose.getByLabelText(/Valid from/), '2026-11-01');
    await userEvent.click(choose.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The policy was added.')).toBeVisible();
    expect(screen.getByText('STAR-NEW-9')).toBeVisible();
  });

  it('requests a pre-authorization, records the answer and shows the new limit', async () => {
    await openTab();
    await screen.findByText('STAR-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Request pre-authorization' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request pre-authorization' });
    const ask = within(dialog);
    await userEvent.type(ask.getByLabelText(/Treatment or procedure/), 'Cataract surgery');
    await userEvent.type(ask.getByLabelText(/Amount asked for/), '30000');
    await userEvent.type(ask.getByLabelText(/Documents enclosed/), 'Eye report{enter}Referral');
    await userEvent.click(ask.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('The request was recorded.')).toBeVisible();
    expect(screen.getByText('Waiting for the payer')).toBeVisible();
    expect(screen.getByText('Eye report, Referral')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Record the answer' }));
    const answer = within(await screen.findByRole('dialog', { name: /Record the payer/ }));
    await userEvent.click(answer.getByRole('button', { name: 'Save' }));
    expect(await answer.findByText(/required/i)).toBeVisible();
    await userEvent.type(answer.getByLabelText(/Amount approved/), '25000');
    await userEvent.click(answer.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The approval was recorded.')).toBeVisible();
    expect(screen.getByText(/Approved: [^0-9]*25,000.00/i)).toBeVisible();
  });

  it('withdraws a request only after a confirmation', async () => {
    await openTab();
    await screen.findByText('STAR-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Request pre-authorization' }));
    const ask = within(await screen.findByRole('dialog', { name: 'Request pre-authorization' }));
    await userEvent.type(ask.getByLabelText(/Treatment or procedure/), 'Scan');
    await userEvent.type(ask.getByLabelText(/Amount asked for/), '100');
    await userEvent.click(ask.getByRole('button', { name: 'Send request' }));
    await screen.findByText('The request was recorded.');
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Withdraw request',
      }),
    );
    expect(await screen.findByText('The request was withdrawn.')).toBeVisible();
    expect(screen.getByText('Withdrawn')).toBeVisible();
  });

  it('ends a policy, which then backs no new request', async () => {
    await openTab();
    await screen.findByText('STAR-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'End policy' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'End policy' }),
    );
    expect(await screen.findByText('The policy was ended.')).toBeVisible();
    expect(screen.getByText('Ended')).toBeVisible();
    expect(
      screen.getByText('Add an active policy before asking a payer for approval.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request pre-authorization' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('offers no changes without policy:manage and preauth:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'policy:manage');
    revokePermission(HOSPITAL, 'admin', 'preauth:manage');
    await openTab();
    await screen.findByText('STAR-2026-0001');
    expect(screen.queryByRole('button', { name: 'Add a policy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End policy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request pre-authorization' })).toBeNull();
  });

  it('shows only the policies when preauth:read is missing', async () => {
    revokePermission(HOSPITAL, 'admin', 'preauth:read');
    await openTab();
    await screen.findByText('STAR-2026-0001');
    expect(screen.queryByRole('heading', { name: 'Pre-authorizations' })).toBeNull();
  });

  it('has no tab without policy:read, or when the module is off', async () => {
    revokePermission(HOSPITAL, 'admin', 'policy:read');
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('tab', { name: 'Insurance' })).toBeNull();
  });

  it('has no tab when the insurance module is off for the hospital', async () => {
    setTenantFeature(HOSPITAL, 'insurance', false);
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('tab', { name: 'Insurance' })).toBeNull();
  });

  it('keeps one hospital out of the other: the clinic sees only its own policy', async () => {
    setTenantFeature(CLINIC, 'insurance', true);
    for (const permission of ['policy:read', 'preauth:read']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    await openTab('ptc_00001');
    expect(await screen.findByText('CARE-77')).toBeVisible();
    expect(screen.queryByText('STAR-2026-0001')).toBeNull();
  });
});

describe('the cover panel of the invoice builder', () => {
  it('shows the approved limit and warns that the bill is near it', async () => {
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    const panel = await screen.findByRole('region', { name: 'Insurance cover for this visit' });
    expect(await within(panel).findByText(/Approved: [^0-9]*50,000.00/i)).toBeVisible();
    expect(within(panel).getByText(/Billed so far: [^0-9]*42,000.00/i)).toBeVisible();
    expect(within(panel).getByText(/Left: [^0-9]*8,000.00/i)).toBeVisible();
    expect(within(panel).getByText(/84% used, near the limit/)).toBeVisible();
    expect(within(panel).getByText(/The bill is near the approved limit/)).toBeVisible();
  });

  it('is left out of a visit without pre-authorization, and without preauth:read', async () => {
    renderApp({ entry: '/billing/new?encounterId=enc_h_2' });
    await screen.findByRole('heading', { name: /new invoice|invoice/i, level: 1 });
    expect(screen.queryByRole('region', { name: 'Insurance cover for this visit' })).toBeNull();
  });

  it('is hidden without preauth:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'preauth:read');
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(screen.queryByText(/Approved: /)).toBeNull());
  });
});
