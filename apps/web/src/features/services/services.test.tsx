import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockService, MOCK_FUTURE_DATE } from '@/mocks/handlers/services';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { serviceKeys } from './hooks/use-services';
import { currencyDigits, fromMinor, todayIn, toMinor } from './schemas';

const HEADING = { name: 'Services and prices', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
/** General consultation, ₹500.00 since April 2025 and ₹450.00 the year before. */
const CONSULTATION = 'svc_h_01';
/** ECG: ₹400.00 in force, and ₹450.00 scheduled far ahead. */
const ECG = 'svc_h_10';
/** Tele-review: set up, not priced yet. */
const UNPRICED = 'svc_h_05';

const openList = async () => {
  const app = renderApp({ entry: '/services' });
  await screen.findByRole('link', { name: 'Abdominal ultrasound' });
  return app;
};
const openService = async (id = CONSULTATION) => {
  const app = renderApp({ entry: `/services/${id}` });
  await screen.findByRole('heading', { name: 'Prices' });
  await waitFor(() => expect(priceRows().length).toBeGreaterThan(0));
  return app;
};
const openCreate = async () => {
  const app = renderApp({ entry: '/services/new' });
  await screen.findByRole('heading', { name: 'Add a service' });
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const textbox = (name: RegExp) => screen.getByRole('textbox', { name });
const choose = (name: RegExp, option: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name }), option);
/** The statuses in the price history, newest first. */
const priceRows = () =>
  screen.queryAllByText(/^(In force|Scheduled|Past)$/).map((cell) => cell.textContent);
const pricesOf = async (serviceId: string) =>
  (await api.GET('/services/{serviceId}/prices', { params: { path: { serviceId } } })).data
    ?.items ?? [];

async function type(name: RegExp, text: string) {
  await userEvent.clear(textbox(name));
  if (text) await userEvent.type(textbox(name), text);
}

const setDate = (value: string) =>
  fireEvent.change(screen.getByLabelText(/^From/), { target: { value } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the catalog', () => {
  it('lists the hospital’s services by name with today’s price, a page at a time', async () => {
    await openList();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('31 services'));
    expect(screen.getByText('CON-001')).toBeInTheDocument();
    expect(screen.getByText('₹500.00')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Wound dressing' })).not.toBeInTheDocument();
    // An archived service is not offered.
    expect(screen.queryByRole('link', { name: 'Old health check' })).not.toBeInTheDocument();

    await userEvent.click(button('Load more'));
    expect(await screen.findByRole('link', { name: 'Wound dressing' })).toBeInTheDocument();
    // A service that was set up and not priced yet says so.
    expect(screen.getByText('No price')).toBeInTheDocument();
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Services and prices' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('narrows to a category, and searches the code and the name on the server', async () => {
    await openList();
    await choose(/^Category/, 'Imaging');
    await waitFor(() => expect(statuses()).toContain('5 services'));
    expect(screen.getByRole('link', { name: 'MRI brain' })).toBeInTheDocument();

    await choose(/^Category/, 'All categories');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search services' }), 'lab-00');
    await waitFor(() => expect(statuses()).toContain('7 services'));

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search services' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search services' }), 'nothing');
    expect(await screen.findByText('No service matches these filters.')).toBeInTheDocument();
  });

  it('shows the archived services only when asked', async () => {
    await openList();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived services' }));

    expect(await screen.findByRole('link', { name: 'Old health check' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 archived service'));
    expect(screen.queryByRole('link', { name: 'Abdominal ultrasound' })).not.toBeInTheDocument();
  });
});

describe('adding a service', () => {
  it('adds it with its first price and opens it', async () => {
    const { router } = await openCreate();
    await type(/^Code/, 'PHY-001');
    await type(/^Name/, 'Physiotherapy session');
    await choose(/^Category/, 'Procedure');
    await choose(/^Tax class/, 'Exempt');
    await type(/^Description/, '45 minutes');
    await type(/^Price from today/, '1,350.50');
    await userEvent.click(button('Add service'));

    expect(
      await screen.findByRole('heading', { name: 'Physiotherapy session' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/services/svc_new_1');
    expect(screen.getByText('45 minutes')).toBeInTheDocument();
    // Its one price, in force from today.
    expect(await screen.findByText('₹1,350.50')).toBeInTheDocument();
    expect(priceRows()).toEqual(['In force']);
  });

  it('may be added without a price', async () => {
    await openCreate();
    await type(/^Code/, 'PHY-002');
    await type(/^Name/, 'Home visit');
    await choose(/^Category/, 'Consultation');
    await choose(/^Tax class/, 'Exempt');
    await userEvent.click(button('Add service'));

    expect(await screen.findByRole('heading', { name: 'Home visit' })).toBeInTheDocument();
    expect(await screen.findByText('This service has no price yet.')).toBeInTheDocument();
  });

  it('needs a code, a name, a category and a tax class, and an amount that is one', async () => {
    let sent = 0;
    server.use(
      http.post('*/api/services', () => {
        sent++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await openCreate();
    await userEvent.click(button('Add service'));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(4);

    await type(/^Code/, 'bad code!');
    await type(/^Name/, 'Something');
    await choose(/^Category/, 'Procedure');
    await choose(/^Tax class/, 'Exempt');
    // More decimals than a rupee has.
    await type(/^Price from today/, '12.345');
    await userEvent.click(button('Add service'));

    await waitFor(() => expect(textbox(/^Code/)).toHaveAttribute('aria-invalid', 'true'));
    expect(textbox(/^Price from today/)).toHaveAttribute('aria-invalid', 'true');
    expect(sent).toBe(0);
  });

  it('refuses a code the hospital already uses, and keeps what was typed', async () => {
    await openCreate();
    await type(/^Code/, 'con-001');
    await type(/^Name/, 'Another consultation');
    await choose(/^Category/, 'Consultation');
    await choose(/^Tax class/, 'Exempt');
    await userEvent.click(button('Add service'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This hospital already has a service with that code.',
    );
    expect(textbox(/^Name/)).toHaveValue('Another consultation');
  });
});

describe('a service', () => {
  it('shows its details, which never include a way to change the code', async () => {
    await openService();

    expect(screen.getByRole('heading', { name: 'General consultation' })).toBeInTheDocument();
    expect(screen.getAllByText('CON-001').length).toBeGreaterThan(0);
    await userEvent.click(button('Edit details'));
    expect(screen.queryByRole('textbox', { name: /^Code/ })).not.toBeInTheDocument();
    expect(textbox(/^Name/)).toHaveValue('General consultation');
  });

  it('sends only what was changed', async () => {
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH')
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body));
    });
    await openService();
    await userEvent.click(button('Edit details'));
    await type(/^Name/, 'General physician consultation');
    await userEvent.click(button('Save service'));

    await waitFor(() => expect(statuses()).toContain('The service was saved.'));
    expect(
      await screen.findByRole('heading', { name: 'General physician consultation' }),
    ).toBeInTheDocument();
    expect(bodies).toEqual([{ name: 'General physician consultation', expectedVersion: 1 }]);
    server.events.removeAllListeners();
  });

  it('keeps what was typed after a conflict, and saves it without undoing the other change', async () => {
    await openService();
    await userEvent.click(button('Edit details'));
    // Someone else changes the tax class meanwhile.
    editMockService(CONSULTATION, { taxClass: 'reduced' });

    await type(/^Name/, 'OPD consultation');
    await userEvent.click(button('Save service'));

    expect(await screen.findByText(/Someone else changed this service/)).toBeInTheDocument();
    expect(textbox(/^Name/)).toHaveValue('OPD consultation');

    await waitFor(() => expect(button('Save service')).toBeEnabled());
    await userEvent.click(button('Save service'));

    await waitFor(() => expect(statuses()).toContain('The service was saved.'));
    expect(await screen.findByRole('heading', { name: 'OPD consultation' })).toBeInTheDocument();
    // Only the name was sent: their tax class is still there.
    expect(screen.getByText('Reduced rate')).toBeInTheDocument();
  });

  it('archives and restores, and takes no new price while archived', async () => {
    await openService();
    expect(screen.getByRole('heading', { name: 'Set a new price' })).toBeInTheDocument();

    await userEvent.click(button('Archive'));
    await waitFor(() => expect(statuses()).toContain('General consultation was archived.'));
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Set a new price' })).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(statuses()).toContain('General consultation was restored.'));
    expect(await screen.findByRole('heading', { name: 'Set a new price' })).toBeInTheDocument();
  });

  it('has one answer for a service that does not exist and one of another hospital', async () => {
    renderApp({ entry: '/services/svc_c_33' });

    expect(await screen.findByRole('heading', { name: 'Service not found' })).toBeInTheDocument();
  });
});

describe('prices', () => {
  it('shows the history: what is in force, and what was', async () => {
    await openService();

    expect(priceRows()).toEqual(['In force', 'Past']);
    expect(screen.getByText('₹500.00')).toBeInTheDocument();
    expect(screen.getByText('₹450.00')).toBeInTheDocument();
    expect(screen.getByText('No end date')).toBeInTheDocument();
    // History is not something to withdraw.
    for (const withdraw of screen.getAllByRole('button', { name: /^Withdraw/ })) {
      expect(withdraw).toBeDisabled();
    }
  });

  it('sets a new price from a date, and ends the one before it the day before', async () => {
    await openService();
    await type(/^Price \(/, '650');
    setDate('2099-06-01');
    await userEvent.click(button('Set price'));

    await waitFor(() =>
      expect(statuses().some((text) => /^The price from .* was set\.$/.test(text ?? ''))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(priceRows()).toEqual(['Scheduled', 'In force', 'Past']));
    expect(screen.getByText('₹650.00')).toBeInTheDocument();

    const prices = await pricesOf(CONSULTATION);
    expect(prices[0]).toMatchObject({ amountMinor: 65000, effectiveFrom: '2099-06-01' });
    // The price that was in force still is, unchanged but for its end.
    expect(prices[1]).toMatchObject({
      amountMinor: 50000,
      effectiveFrom: '2025-04-01',
      effectiveTo: '2099-05-31',
    });
    expect(prices[2]).toMatchObject({ amountMinor: 45000, effectiveTo: '2025-03-31' });
  });

  it('prices a service that had none, from today', async () => {
    renderApp({ entry: `/services/${UNPRICED}` });
    await screen.findByText('This service has no price yet.');
    await type(/^Price \(/, '300');
    await userEvent.click(button('Set price'));

    await waitFor(() => expect(priceRows()).toEqual(['In force']));
    const service = await api.GET('/services/{serviceId}', {
      params: { path: { serviceId: UNPRICED } },
    });
    expect(service.data?.currentPrice).toMatchObject({
      amountMinor: 30000,
      effectiveFrom: todayIn('Asia/Kolkata'),
    });
  });

  it('refuses a date that a price already starts on or after', async () => {
    await openService(ECG);
    expect(priceRows()).toEqual(['Scheduled', 'In force', 'Past']);
    await type(/^Price \(/, '420');
    setDate('2098-06-01');
    await userEvent.click(button('Set price'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A price already starts on or after that date.',
    );
    expect(await pricesOf(ECG)).toHaveLength(3);
  });

  it('withdraws a price that has not started, and the one before carries on', async () => {
    await openService(ECG);
    const scheduled = screen
      .getAllByRole('button', { name: /^Withdraw/ })
      .filter((withdraw) => !(withdraw as HTMLButtonElement).disabled);
    expect(scheduled).toHaveLength(1);
    await userEvent.click(scheduled[0] as HTMLElement);

    await waitFor(() => expect(statuses()).toContain('The scheduled price was withdrawn.'));
    await waitFor(() => expect(priceRows()).toEqual(['In force', 'Past']));
    const prices = await pricesOf(ECG);
    expect(prices[0]).toMatchObject({ amountMinor: 40000 });
    expect(prices[0]?.effectiveTo).toBeUndefined();
  });

  it('never takes a date in the past, on the screen or on the server', async () => {
    await openService();
    await type(/^Price \(/, '650');
    setDate('2020-01-01');
    await userEvent.click(button('Set price'));

    await waitFor(() =>
      expect(screen.getByLabelText(/^From/)).toHaveAttribute('aria-invalid', 'true'),
    );
    await expect(
      api.POST('/services/{serviceId}/prices', {
        params: { path: { serviceId: CONSULTATION } },
        body: { amountMinor: 65000, effectiveFrom: '2020-01-01' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    // A price that is in force is not withdrawn either.
    await expect(
      api.DELETE('/services/{serviceId}/prices/{priceId}', {
        params: { path: { serviceId: CONSULTATION, priceId: `${CONSULTATION}_p2` } },
      }),
    ).rejects.toMatchObject({ serverCode: 'price_in_force' });
    expect(await pricesOf(CONSULTATION)).toHaveLength(2);
    expect(MOCK_FUTURE_DATE > todayIn('UTC')).toBe(true);
  });

  it('turns what is typed into minor units without rounding', () => {
    expect(toMinor('1250', 2)).toBe(125000);
    expect(toMinor(' 1,250.5 ', 2)).toBe(125050);
    expect(toMinor('0.07', 2)).toBe(7);
    expect(toMinor('19.99', 2)).toBe(1999);
    expect(toMinor('1.999', 3)).toBe(1999);
    expect(toMinor('500', 0)).toBe(500);
    for (const bad of ['', '-5', '12.345', '1e3', 'abc', '5.', '500.5']) {
      expect(toMinor(bad, bad === '500.5' ? 0 : 2), bad).toBe(bad === '5.' ? 500 : null);
    }
    expect(fromMinor(125050, 2)).toBe('1250.50');
    expect(fromMinor(7, 2)).toBe('0.07');
    expect(fromMinor(500, 0)).toBe('500');
    expect([currencyDigits('INR'), currencyDigits('JPY'), currencyDigits('KWD')]).toEqual([
      2, 0, 3,
    ]);
    expect(currencyDigits('not a currency')).toBe(2);
  });
});

describe('a screen that is too narrow', () => {
  it('says the screen needs a wider display, and asks the server for nothing', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    let asked = 0;
    server.use(
      http.get('*/api/services', () => {
        asked++;
        return undefined;
      }),
    );
    renderApp({ entry: '/services' });

    expect(
      await screen.findByRole('heading', { name: 'This screen needs a wider display' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', HEADING)).not.toBeInTheDocument();
    // Still inside the app: the navigation is there.
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

describe('access', () => {
  it('lets someone who may only read see services and prices, with nothing to change them', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openList();
    expect(screen.queryByRole('link', { name: 'Add a service' })).not.toBeInTheDocument();

    renderApp({ entry: `/services/${ECG}` });
    const prices = await screen.findByRole('region', { name: 'Prices' });
    await within(prices).findByText('Scheduled');
    expect(screen.queryByRole('button', { name: /Edit details|Archive/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Withdraw|Set price/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Set a new price' })).not.toBeInTheDocument();
  });

  it('keeps the add screen from someone who may only read', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/services/new' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const path = { serviceId: CONSULTATION };

    await expect(
      api.POST('/services', {
        body: { code: 'X-1', name: 'X', category: 'lab', taxClass: 'exempt' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.PATCH('/services/{serviceId}', {
        params: { path },
        body: { name: 'X', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.POST('/services/{serviceId}/prices', {
        params: { path },
        body: { amountMinor: 1, effectiveFrom: MOCK_FUTURE_DATE },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.POST('/services/{serviceId}/archive', { params: { path } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'service:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/services' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Services and prices' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'services', false);
    renderApp({ entry: '/services' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Services and prices' })).not.toBeInTheDocument();
    await expect(api.GET('/services', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s catalog in the other, and prices in each one’s currency', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: serviceKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: serviceKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/services');
    expect(await screen.findByRole('link', { name: 'Vaccination' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('2 services'));
    expect(screen.getByText(/AED\s*150\.00/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Abdominal ultrasound' })).not.toBeInTheDocument();
  });

  it('cannot read, change or price another hospital’s service', async () => {
    // The admin belongs to the hospital only. A clinic service does not exist for them.
    const path = { serviceId: 'svc_c_33' };
    await expect(api.GET('/services/{serviceId}', { params: { path } })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      api.GET('/services/{serviceId}/prices', { params: { path } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      api.POST('/services/{serviceId}/prices', {
        params: { path },
        body: { amountMinor: 1, effectiveFrom: MOCK_FUTURE_DATE },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Nor withdraw one of its prices through a service of their own.
    await expect(
      api.DELETE('/services/{serviceId}/prices/{priceId}', {
        params: { path: { serviceId: CONSULTATION, priceId: 'svc_c_33_p2' } },
      }),
    ).rejects.toMatchObject({ serverCode: 'price_not_found' });
  });

  it('may use a code another hospital uses', async () => {
    // Both hospitals have a CON-001 of their own. A code is unique per hospital.
    const mine = await api.GET('/services', { params: { query: { q: 'CON-001' } } });
    expect(mine.data?.items.map((item) => item.tenantId)).toEqual([TENANT_IDS.hospital]);
    await expect(
      api.POST('/services', {
        body: { code: 'PRO-001', name: 'Second', category: 'procedure', taxClass: 'exempt' },
      }),
    ).rejects.toMatchObject({ serverCode: 'service_code_taken' });
  });
});
