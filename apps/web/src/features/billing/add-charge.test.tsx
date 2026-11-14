import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import type { Charge } from './types';
import { mockCharges } from '@/mocks/handlers/billing';
import { editMockService, mockServiceNamed } from '@/mocks/handlers/services';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Charging a service of the price catalog to a visit by hand (#115). The hospital's visit
// enc_h_1 has three pending charges (901.00); the price comes from the catalog, never the form.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const NEW = '/billing/new?encounterId=enc_h_1';

const charges = () => screen.getByRole('table', { name: 'Pending charges' });
const total = () => screen.getByTestId('invoice-total');

async function openBuilder(entry = NEW, ready = 'Complete blood count') {
  renderApp({ entry });
  await screen.findByRole('heading', { name: 'New invoice', level: 1 });
  await within(await screen.findByRole('table', { name: 'Pending charges' })).findByText(ready);
}

async function chooseService(name: string, term = name) {
  await userEvent.type(screen.getByRole('combobox', { name: 'Service' }), term);
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

describe('charging a service by hand', () => {
  it('posts it at the catalog price, puts it on the bill and totals it', async () => {
    await openBuilder();
    await chooseService('Wound dressing');
    expect(await screen.findByTestId('chosen-service')).toHaveTextContent('Wound dressing');
    const quantity = screen.getByRole('textbox', { name: /^How many/ });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '2');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));

    const row = await within(charges()).findByText('Wound dressing');
    expect(row).toBeInTheDocument();
    expect(await screen.findByText('Wound dressing added to the pending charges.')).toBeVisible();
    // 2 x 250.00 from the catalog, on top of 901.00.
    await waitFor(() => expect(total()).toHaveTextContent('₹1,401.00'));
    expect(screen.getByText('4 lines on this bill')).toBeInTheDocument();
    const posted = mockCharges().find((charge) => charge.description === 'Wound dressing');
    expect(posted).toMatchObject({ source: 'service', unitPriceMinor: 25000, quantity: 2 });
    await expectNoAxeViolations();
  });

  it('says where each charge came from', async () => {
    await openBuilder();
    expect(within(charges()).getByText('Dispensed medicine')).toBeInTheDocument();
    expect(within(charges()).getByText('Order')).toBeInTheDocument();
  });

  it('asks for a service first, and for a sensible quantity', async () => {
    await openBuilder();
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    expect(await screen.findByText('Choose a service first.')).toBeInTheDocument();

    await chooseService('Suturing');
    const quantity = screen.getByRole('textbox', { name: /^How many/ });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    expect(await screen.findByText('Type a number from 1 to 9999.')).toBeInTheDocument();
    expect(mockCharges().some((charge) => charge.description === 'Suturing')).toBe(false);
  });

  it('says so when the service was archived, or has no price, meanwhile', async () => {
    await openBuilder();
    await chooseService('Suturing');
    editMockService(mockServiceNamed(HOSPITAL, 'Suturing')?.id ?? '', { archived: true });
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    expect(
      await screen.findByText('This service is no longer offered. Choose another.'),
    ).toBeInTheDocument();
    expect(total()).toHaveTextContent('₹901.00');
  });

  it('shows a service without a price as refused, not at nothing', async () => {
    await openBuilder();
    await chooseService('Tele-review');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    expect(
      await screen.findByText(
        'This service has no price in effect. Set its price in the price catalog first.',
      ),
    ).toBeInTheDocument();
    expect(total()).toHaveTextContent('₹901.00');
  });

  it('sends one request for a double click', async () => {
    let posts = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.includes('/charges')) posts += 1;
    });
    await openBuilder();
    await chooseService('Nebulisation');
    const button = screen.getByRole('button', { name: 'Add charge' });
    await userEvent.dblClick(button);
    await within(charges()).findByText('Nebulisation');
    expect(posts).toBe(1);
    server.events.removeAllListeners();
  });

  it('shows a refusal of the server in words', async () => {
    server.use(
      http.post('*/api/encounters/:encounterId/charges', () =>
        HttpResponse.json(
          { error: { code: 'encounter_cancelled', message: 'x' } },
          { status: 409 },
        ),
      ),
    );
    await openBuilder();
    await chooseService('ECG');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    expect(
      await screen.findByText('This visit was cancelled and has nothing to bill.'),
    ).toBeInTheDocument();
  });
});

describe('assembling the bill', () => {
  it('keeps what was left off the bill when a service is added', async () => {
    await openBuilder();
    await userEvent.click(
      within(charges()).getByRole('button', { name: 'Leave off the bill: Complete blood count' }),
    );
    expect(total()).toHaveTextContent('₹551.00');
    await chooseService('Injection administration');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    await within(charges()).findByText('Injection administration');
    // 551.00 + 100.00: the blood count stays off, the new charge is on.
    await waitFor(() => expect(total()).toHaveTextContent('₹651.00'));
    expect(
      within(charges()).getByRole('button', { name: 'Add to the bill: Complete blood count' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('says in words what needs a look on a flagged charge', async () => {
    const flagged = (id: string, description: string, flag: string) => ({
      id,
      tenantId: HOSPITAL,
      encounterId: 'enc_h_1',
      source: 'order',
      description,
      quantity: 1,
      unitPriceMinor: 1000,
      totalMinor: 1000,
      status: 'pending',
      flag,
      postedAt: '2026-01-01T00:00:00Z',
    });
    server.use(
      http.get('*/api/encounters/:encounterId/charges', () =>
        HttpResponse.json({
          items: [
            flagged('f1', 'Old scan', 'service_archived'),
            flagged('f2', 'Unpriced test', 'no_price'),
            flagged('f3', 'Returned tablets', 'return_review'),
          ],
          nextCursor: null,
        }),
      ),
    );
    await openBuilder(NEW, 'Old scan');
    expect(within(charges()).getByText('Service no longer offered: last price')).toBeVisible();
    expect(within(charges()).getByText('No price set: check it')).toBeVisible();
    expect(within(charges()).getByText('Medicine brought back: credit it')).toBeVisible();
  });

  it('keeps the same key when a failed request is sent again', async () => {
    const keys: string[] = [];
    let fail = true;
    server.use(
      http.post('*/api/encounters/:encounterId/charges', ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
        if (fail) {
          fail = false;
          return HttpResponse.json(
            { error: { code: 'unavailable', message: 'x' } },
            { status: 503 },
          );
        }
        return HttpResponse.json(
          {
            id: 'chg_retry',
            tenantId: HOSPITAL,
            encounterId: 'enc_h_1',
            source: 'service',
            description: 'ECG',
            quantity: 1,
            unitPriceMinor: 40000,
            totalMinor: 40000,
            status: 'pending',
            postedAt: '2026-01-01T00:00:00Z',
          },
          { status: 201 },
        );
      }),
    );
    await openBuilder();
    await chooseService('ECG');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Add charge' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });
});

describe('who may charge a service', () => {
  it('needs charge:create: without it there is no form', async () => {
    revokePermission(HOSPITAL, 'admin', 'charge:create');
    await openBuilder();
    expect(screen.queryByRole('heading', { name: 'Charge a service' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add charge' })).toBeNull();
    expect(total()).toHaveTextContent('₹901.00');
  });

  it('needs charge:read as well, as the API does', async () => {
    revokePermission(HOSPITAL, 'admin', 'charge:read');
    renderApp({ entry: NEW });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add charge' })).toBeNull();
  });

  it('is gone with the billing module off', async () => {
    setTenantFeature(HOSPITAL, 'billing', false);
    renderApp({ entry: NEW });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add charge' })).toBeNull();
  });

  it('charges the clinic’s own catalog, in its own currency', async () => {
    // A doctor of both hospitals, given what charging needs at the clinic only.
    for (const permission of ['charge:read', 'charge:create', 'invoice:create', 'invoice:read']) {
      grantPermission(CLINIC, 'doctor', permission);
    }
    grantPermission(CLINIC, 'doctor', 'service:read');
    signIn(USER_IDS.doctor, CLINIC);
    await openBuilder('/billing/new?encounterId=enc_c_1', 'General consultation');
    await chooseService('Vaccination');
    await userEvent.click(screen.getByRole('button', { name: 'Add charge' }));
    await within(charges()).findByText('Vaccination');
    await waitFor(() => expect(total()).toHaveTextContent('230.00'));
    // The hospital's services are not the clinic's to find.
    await userEvent.type(screen.getByRole('combobox', { name: 'Service' }), 'Suturing');
    expect((await screen.findAllByText('No service matches.')).length).toBeGreaterThan(0);
  });
});

describe('resolving a flagged charge (#910)', () => {
  const flag = (id: string, value: Charge['flag']) => {
    const found = (mockCharges() as Charge[]).find((each) => each.id === id);
    if (found) found.flag = value;
  };
  const row = () => within(charges()).getByRole('row', { name: /Complete blood count/ });

  it('takes the flag off with a reason, after a confirmation, and the bill can be issued', async () => {
    flag('chg_h_2', 'return_review');
    await openBuilder();
    expect(within(row()).getByText('Medicine brought back: credit it')).toBeVisible();
    await userEvent.click(within(row()).getByRole('button', { name: /Mark as reviewed/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Mark this charge as reviewed' });
    await expectNoAxeViolations();
    // The reason is required.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as reviewed' }));
    expect(await within(dialog).findByText(/required|Enter/i)).toBeInTheDocument();
    expect((mockCharges() as Charge[]).find((each) => each.id === 'chg_h_2')?.flag).toBe(
      'return_review',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /What was done/ }),
      'Credit note raised',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as reviewed' }));
    expect(await screen.findByText('Complete blood count marked as reviewed.')).toBeVisible();
    await waitFor(() =>
      expect(within(row()).queryByText('Medicine brought back: credit it')).toBeNull(),
    );
    expect((mockCharges() as Charge[]).find((each) => each.id === 'chg_h_2')?.flag).toBeUndefined();
  });

  it('is not offered without invoice:issue', async () => {
    flag('chg_h_2', 'relink_review');
    revokePermission(HOSPITAL, 'admin', 'invoice:issue');
    await openBuilder();
    expect(within(row()).queryByRole('button', { name: /Mark as reviewed/ })).toBeNull();
  });

  it('refuses a charge of another hospital', async () => {
    const response = await fetch('/api/charges/chg_c_1/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    expect(response.status).toBe(404);
  });
});
