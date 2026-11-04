import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { grantPermission, revokePermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { mockCharges, setMockPackage } from '@/mocks/handlers/billing';
import { mockServiceNamed } from '@/mocks/handlers/services';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Packages (#117): what a package includes, and applying one to a visit as a single charge at
// its own price. The hospital's visit enc_h_1 has three pending charges (901.00).

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NEW = '/billing/new?encounterId=enc_h_1';

const charges = () => screen.getByRole('table', { name: 'Pending charges' });
const total = () => screen.getByTestId('invoice-total');
const idOf = (name: string) => mockServiceNamed(HOSPITAL, name)?.id ?? '';

async function openBuilder() {
  renderApp({ entry: NEW });
  await screen.findByRole('heading', { name: 'New invoice', level: 1 });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(
    'Complete blood count',
  );
}

async function chooseService(name: string) {
  await userEvent.type(screen.getByRole('combobox', { name: 'Service' }), name);
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

async function choosePackage(name: string) {
  await userEvent.type(screen.getByRole('combobox', { name: 'Package' }), name);
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

describe('applying a package to a visit', () => {
  it('replaces the charges for what it includes with one charge at its price', async () => {
    setMockPackage(HOSPITAL, idOf('Basic health check'), [
      { serviceId: idOf('Wound dressing'), kind: 'included' },
      { serviceId: idOf('Suturing'), kind: 'excluded' },
    ]);
    await openBuilder();
    await chooseService('Wound dressing');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    await within(charges()).findByText('Wound dressing');
    // 901.00 and the dressing at 250.00.
    await waitFor(() => expect(total()).toHaveTextContent('₹1,151.00'));

    await choosePackage('Basic health check');
    expect(await screen.findByTestId('chosen-package')).toHaveTextContent('Basic health check');
    await userEvent.click(screen.getByRole('button', { name: 'Apply package' }));

    expect(await within(charges()).findByText('Basic health check')).toBeInTheDocument();
    expect(within(charges()).getByText('Package')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(charges()).queryByText('Wound dressing')).not.toBeInTheDocument(),
    );
    // 901.00 and the package at 2,500.00: the dressing is no longer billed.
    await waitFor(() => expect(total()).toHaveTextContent('₹3,401.00'));
    expect(
      await screen.findByText(/Basic health check applied: its charges replace/),
    ).toBeVisible();
    const covered = mockCharges().find((charge) => charge.description === 'Wound dressing');
    expect(covered).toMatchObject({ status: 'void', flag: 'package_covered' });
    await expectNoAxeViolations();
  }, 20_000);

  it('covers an included service charged afterwards, and bills an excluded one', async () => {
    setMockPackage(HOSPITAL, idOf('Basic health check'), [
      { serviceId: idOf('Wound dressing'), kind: 'included' },
      { serviceId: idOf('Suturing'), kind: 'excluded' },
    ]);
    await openBuilder();
    await choosePackage('Basic health check');
    await userEvent.click(screen.getByRole('button', { name: 'Apply package' }));
    await within(charges()).findByText('Basic health check');

    await chooseService('Wound dressing');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    await screen.findByText('Wound dressing added to the pending charges.');
    expect(within(charges()).queryByText('Wound dressing')).not.toBeInTheDocument();

    await chooseService('Suturing');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    expect(await within(charges()).findByText('Suturing')).toBeInTheDocument();
  }, 20_000);

  it('says so when the package has nothing included', async () => {
    await openBuilder();
    await choosePackage('Executive health check');
    await userEvent.click(screen.getByRole('button', { name: 'Apply package' }));
    expect(
      await screen.findByText('This package includes nothing yet. Set its contents first.'),
    ).toBeInTheDocument();
  });

  it('says so when the package is already on the visit', async () => {
    server.use(
      http.post('*/api/encounters/:encounterId/packages', () =>
        HttpResponse.json({ error: { code: 'package_applied', message: 'x' } }, { status: 409 }),
      ),
    );
    await openBuilder();
    await choosePackage('Basic health check');
    await userEvent.click(screen.getByRole('button', { name: 'Apply package' }));
    expect(await screen.findByText('This package is already on the visit.')).toBeInTheDocument();
  });

  it('asks for a package first', async () => {
    await openBuilder();
    await userEvent.click(screen.getByRole('button', { name: 'Apply package' }));
    expect(await screen.findByText('Choose a package first.')).toBeInTheDocument();
  });

  it('is not offered without the permission to charge', async () => {
    revokePermission(HOSPITAL, 'admin', 'charge:create');
    await openBuilder();
    expect(screen.queryByRole('heading', { name: 'Apply a package' })).not.toBeInTheDocument();
  });
});

describe('the contents of a package', () => {
  async function openEditor() {
    renderApp({ entry: '/billing/packages' });
    await screen.findByRole('heading', { name: 'Package contents', level: 1 });
    await userEvent.type(screen.getByRole('combobox', { name: 'Package' }), 'Basic health');
    await userEvent.click(await screen.findByRole('option', { name: /Basic health check/ }));
    await screen.findByRole('heading', { name: 'Contents of Basic health check' });
  }

  async function addService(name: string, button: string) {
    await userEvent.type(screen.getByRole('combobox', { name: 'Add a service' }), name);
    await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
    await userEvent.click(screen.getByRole('button', { name: button }));
  }

  it('sets what is included and what is left out, then saves the whole list', async () => {
    await openEditor();
    await addService('Wound dressing', 'Add as included');
    await addService('Suturing', 'Add as excluded');
    expect(screen.getByText(/Wound dressing/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save contents' }));
    expect(await screen.findByText('Package contents saved.')).toBeVisible();

    // Applying it now covers the dressing and leaves the suturing to be billed.
    setMockPackage(HOSPITAL, idOf('Basic health check'), [
      { serviceId: idOf('Wound dressing'), kind: 'included' },
    ]);
    await expectNoAxeViolations();
  });

  it('removes a service from the list', async () => {
    setMockPackage(HOSPITAL, idOf('Basic health check'), [
      { serviceId: idOf('Wound dressing'), kind: 'included' },
    ]);
    await openEditor();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove Wound dressing from the package' }),
    );
    expect(screen.queryByText(/Wound dressing/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save contents' }));
    expect(await screen.findByText('Package contents saved.')).toBeVisible();
  });

  it('refuses another package as a member, in words', async () => {
    await openEditor();
    await addService('Executive health', 'Add as included');
    await userEvent.click(screen.getByRole('button', { name: 'Save contents' }));
    expect(
      await screen.findByText(
        /cannot be in a package: it must exist, be offered and not be a package/,
      ),
    ).toBeInTheDocument();
  });

  it('is not reachable without the permission, and has no link', async () => {
    revokePermission(HOSPITAL, 'admin', 'package:manage');
    renderApp({ entry: '/billing/invoices' });
    await screen.findByRole('heading', { name: 'Invoices', level: 1 });
    expect(screen.queryByRole('link', { name: 'Package contents' })).not.toBeInTheDocument();
  });

  it('offers a link from the invoice list to someone who may manage packages', async () => {
    renderApp({ entry: '/billing/invoices' });
    expect(await screen.findByRole('link', { name: 'Package contents' })).toHaveAttribute(
      'href',
      '/billing/packages',
    );
  });

  it('finds only the clinic’s own packages at the clinic', async () => {
    for (const permission of ['package:manage', 'charge:read', 'service:read']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/billing/packages' });
    await screen.findByRole('heading', { name: 'Package contents', level: 1 });
    await userEvent.type(screen.getByRole('combobox', { name: 'Package' }), 'health');
    expect((await screen.findAllByText('No service matches.')).length).toBeGreaterThan(0);
  });
});
