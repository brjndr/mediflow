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
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { payerKeys } from './hooks/use-payers';

const NO_ACCESS = { name: 'You do not have access to this page' };
const STAR = 'pyr_h_star';

const openList = async () => {
  const app = renderApp({ entry: '/insurance' });
  await screen.findByRole('link', { name: 'Star Sample Insurance' });
  return app;
};
const openPayer = async (id = STAR) => {
  const app = renderApp({ entry: `/insurance/${id}` });
  await screen.findByRole('heading', { name: 'Plans' });
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const textbox = (name: RegExp) => screen.getByRole('textbox', { name });
async function type(name: RegExp, text: string) {
  await userEvent.clear(textbox(name));
  if (text) await userEvent.type(textbox(name), text);
}
const key = { 'idempotency-key': 'insurance-test-1' };

describe('the insurers, TPAs and corporates', () => {
  it('are listed by name with their kind and plans, and reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Insurers and TPAs' }));

    expect(
      await screen.findByRole('heading', { name: 'Insurers, TPAs and corporates', level: 1 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('3 organisations'));
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toContain('Acme Industries');
    expect(names.indexOf('Acme Industries')).toBeLessThan(names.indexOf('Star Sample Insurance'));
    expect(screen.queryByRole('link', { name: 'Old Sample Assurance' })).not.toBeInTheDocument();
    // Another hospital's organisation is never in the list.
    expect(screen.queryByRole('link', { name: 'Clinic Care Cover' })).not.toBeInTheDocument();
  });

  it('are searched by name or code, filtered by kind, and the archived ones shown when asked', async () => {
    await openList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'medi');
    await waitFor(() => expect(statuses()).toContain('1 organisation'));
    expect(screen.getByRole('link', { name: 'MediAssist Sample TPA' })).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'corporate');
    await waitFor(() => expect(statuses()).toContain('1 organisation'));
    expect(screen.getByRole('link', { name: 'Acme Industries' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), '');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));
    expect(await screen.findByRole('link', { name: 'Old Sample Assurance' })).toBeInTheDocument();
  });

  it('are added with a code of the hospital, and a code in use is refused', async () => {
    renderApp({ entry: '/insurance/new' });
    await screen.findByRole('heading', { name: 'Add an insurer, TPA or corporate' });

    await userEvent.click(button('Add'));
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Kind/ }), 'tpa');
    await type(/^Code/, 'star');
    await type(/^Name/, 'Another TPA');
    await type(/^Email/, 'not an email');
    await userEvent.click(button('Add'));
    expect(await screen.findByText('This value is not in the expected format.')).toBeVisible();

    await type(/^Email/, 'desk@tpa.example');
    await userEvent.click(button('Add'));
    expect(await screen.findByText('That code is already used. Choose another.')).toBeVisible();

    await type(/^Code/, 'ANOTHER');
    await userEvent.click(button('Add'));
    expect(await screen.findByRole('heading', { name: 'Another TPA', level: 1 })).toBeVisible();
    expect(screen.getByText('TPA · ANOTHER')).toBeInTheDocument();
  });
});

describe('a payer', () => {
  it('shows its plans with the terms, and its rate agreements with their phase', async () => {
    await openPayer();

    const plan = within(screen.getAllByText('Gold family floater')[0]!.closest('tr, li')!);
    expect(plan.getByText('10%')).toBeInTheDocument();
    expect(plan.getByText('Everything')).toBeInTheDocument();
    expect(plan.getByText(/pre-authorization/)).toBeInTheDocument();
    expect(plan.getByText(/waiting 30 days/)).toBeInTheDocument();
    const agreement = within(screen.getAllByText('Star network rates 2026')[0]!.closest('tr, li')!);
    expect(agreement.getByText('10%')).toBeInTheDocument();
    expect(agreement.getByText('In force')).toBeInTheDocument();
  });

  it('has its details changed with only the changed fields sent', async () => {
    await openPayer();
    await type(/^Contact person/, 'Priya at claims');
    await userEvent.click(button('Save'));

    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    const found = await api.GET('/payers/{payerId}', { params: { path: { payerId: STAR } } });
    expect(found.data?.payer.contactName).toBe('Priya at claims');
    expect(found.data?.payer.version).toBe(2);
    expect(found.data?.payer.phone).toBe('+91 80 4000 1111');
  });

  it('is archived and restored, and then takes no new plan', async () => {
    await openPayer();
    await userEvent.click(button('Archive this organisation'));
    expect(await screen.findByText('Organisation archived.')).toBeInTheDocument();
    expect(button('Add a plan')).toBeDisabled();

    await userEvent.click(button('Restore this organisation'));
    expect(await screen.findByText('Organisation restored.')).toBeInTheDocument();
  });

  it('gets a plan, checked before it is sent', async () => {
    await openPayer();
    await userEvent.click(button('Add a plan'));
    const dialog = await screen.findByRole('dialog', { name: 'Add a plan' });
    const field = (name: RegExp) => within(dialog).getByRole('textbox', { name });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findAllByText('This field is required.')).length).toBeGreaterThan(
      0,
    );

    await userEvent.type(field(/^Code/), 'SILVER');
    await userEvent.type(field(/^Name/), 'Silver individual');
    await userEvent.clear(field(/^Patient's share/));
    await userEvent.type(field(/^Patient's share/), '150');
    await userEvent.type(field(/^Youngest age/), '60');
    await userEvent.type(field(/^Oldest age/), '40');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /^What the plan covers/ }),
      'only_listed',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('This value is too long or too large.')).toBeVisible();
    expect(within(dialog).getByText('The oldest age cannot be below the youngest.')).toBeVisible();
    expect(
      within(dialog).getByText(
        'Add at least one service, or choose to cover everything except the list.',
      ),
    ).toBeVisible();

    await userEvent.clear(field(/^Patient's share/));
    await userEvent.type(field(/^Patient's share/), '20');
    await userEvent.clear(field(/^Oldest age/));
    await userEvent.type(field(/^Oldest age/), '70');
    await userEvent.type(field(/^Sum insured/), '12,50');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /^What the plan covers/ }),
      'all_except',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('This value is not in the expected format.'),
    ).toBeVisible();

    await userEvent.clear(field(/^Sum insured/));
    await userEvent.type(field(/^Sum insured/), '250000.50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Plan Silver individual saved.')).toBeInTheDocument();
    const found = await api.GET('/payers/{payerId}', { params: { path: { payerId: STAR } } });
    const plan = found.data?.plans.find((one) => one.code === 'SILVER');
    expect(plan).toMatchObject({
      copayPercent: 20,
      sumInsuredMinor: 25000050,
      minAge: 60,
      maxAge: 70,
      coverageMode: 'all_except',
    });
  });

  it('has a plan changed and archived, and a code used twice refused', async () => {
    await openPayer();
    await userEvent.click(await screen.findByRole('button', { name: /^Change.*Gold family/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Gold family floater' });
    await userEvent.clear(within(dialog).getByRole('textbox', { name: /^Patient's share/ }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Patient's share/ }), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Plan Gold family floater saved.')).toBeInTheDocument();
    expect(await screen.findByText('5%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Archive.*Gold family/ }));
    expect(await screen.findByText('Plan Gold family floater archived.')).toBeInTheDocument();
    expect(screen.queryByText('Gold family floater')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived plans' }));
    expect(await screen.findAllByText('Gold family floater')).not.toHaveLength(0);

    const body = {
      code: 'gold',
      name: 'Again',
      coverageMode: 'all_except' as const,
      copayPercent: 0,
      preAuthRequired: false,
      services: [],
    };
    await expect(
      api.POST('/payers/{payerId}/plans', {
        params: { path: { payerId: STAR }, header: key },
        body,
      }),
    ).rejects.toMatchObject({ serverCode: 'duplicate_code' });
  });

  it('gets effective-dated rate agreements that never overlap and never start in the past', async () => {
    await openPayer();
    await userEvent.click(button('Add a rate agreement'));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rate agreement' });
    const within_ = within(dialog);
    const dateField = (name: RegExp) => within_.getByLabelText(name);

    await userEvent.type(within_.getByRole('textbox', { name: /^Name/ }), 'Winter 2027');
    await userEvent.type(dateField(/^First day/), '2027-01-01');
    await userEvent.type(dateField(/^Last day/), '2026-12-01');
    await userEvent.clear(within_.getByRole('textbox', { name: /^Discount/ }));
    await userEvent.type(within_.getByRole('textbox', { name: /^Discount/ }), '12.5');
    await userEvent.click(within_.getByRole('button', { name: 'Save' }));
    expect(await within_.findByText('The last day cannot be before the first.')).toBeVisible();

    // The seeded agreement runs to the end of 2026: this one starts inside it.
    await userEvent.clear(dateField(/^First day/));
    await userEvent.type(dateField(/^First day/), '2026-12-15');
    await userEvent.clear(dateField(/^Last day/));
    await userEvent.type(dateField(/^Last day/), '2027-03-31');
    await userEvent.click(within_.getByRole('button', { name: 'Save' }));
    expect(await within_.findByText(/overlaps another agreement/)).toBeVisible();

    await userEvent.clear(dateField(/^First day/));
    await userEvent.type(dateField(/^First day/), '2027-01-01');
    await userEvent.click(within_.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Agreement Winter 2027 added.')).toBeInTheDocument();
    const row = within(screen.getAllByText('Winter 2027')[0]!.closest('tr, li')!);
    expect(row.getByText('12.5%')).toBeInTheDocument();
    expect(row.getByText('Starts later')).toBeInTheDocument();

    const found = await api.GET('/payers/{payerId}', { params: { path: { payerId: STAR } } });
    expect(found.data?.agreements.find((one) => one.name === 'Winter 2027')?.discountBp).toBe(1250);
    await expect(
      api.POST('/payers/{payerId}/rate-agreements', {
        params: { path: { payerId: STAR }, header: { 'idempotency-key': 'insurance-test-2' } },
        body: { name: 'Old', effectiveFrom: '2020-01-01', discountBp: 0, rates: [] },
      }),
    ).rejects.toMatchObject({ serverCode: 'starts_in_past' });
  });

  it('has a running agreement ended today, and not one that has not started', async () => {
    await openPayer();
    const current = screen.getAllByText('Star network rates 2026')[0]!.closest('tr, li')!;
    await userEvent.click(
      within(current as HTMLElement).getByRole('button', { name: /^End today/ }),
    );

    expect(
      await screen.findByText('Agreement Star network rates 2026 ends today.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('In force').length).toBeGreaterThan(0));
  });

  it('has no axe violations', async () => {
    const { container } = await openPayer();
    await expectNoAxeViolations(container);
  });
});

describe('access', () => {
  it('has no screen and no navigation entry without the permission', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/insurance' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Insurers and TPAs' })).not.toBeInTheDocument();
  });

  it('lets a reader see the organisations but not change them', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'payer:manage');
    renderApp({ entry: `/insurance/${STAR}` });
    await screen.findByRole('heading', { name: 'Plans' });

    expect(screen.queryByRole('button', { name: 'Add a plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Change/ })).not.toBeInTheDocument();
    expect(screen.getByText('Claims desk')).toBeInTheDocument();
    await expect(
      api.POST('/payers', {
        params: { header: key },
        body: { kind: 'insurer', code: 'X', name: 'X' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'insurance', false);
    renderApp({ entry: '/insurance' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Insurers and TPAs' })).not.toBeInTheDocument();
    await expect(api.GET('/payers', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('never show one hospital’s payers in the other', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'insurance', true);
    for (const tenant of [TENANT_IDS.hospital, TENANT_IDS.clinic]) {
      grantPermission(tenant, 'doctor', 'payer:read');
    }
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: payerKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(
      queryClient.getQueryCache().findAll({ queryKey: payerKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/insurance');
    expect(await screen.findByRole('link', { name: 'Clinic Care Cover' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Star Sample Insurance' })).not.toBeInTheDocument();
  });

  it('cannot read or change another hospital’s payer', async () => {
    const path = { payerId: 'pyr_c_care' };
    const gone = { code: 'not_found' };
    await expect(api.GET('/payers/{payerId}', { params: { path } })).rejects.toMatchObject(gone);
    await expect(
      api.PATCH('/payers/{payerId}', { params: { path }, body: { name: 'x', version: 1 } }),
    ).rejects.toMatchObject(gone);
    await expect(
      api.POST('/payers/{payerId}/plans', {
        params: { path, header: key },
        body: {
          code: 'P',
          name: 'P',
          coverageMode: 'all_except',
          copayPercent: 0,
          preAuthRequired: false,
          services: [],
        },
      }),
    ).rejects.toMatchObject(gone);
  });
});
