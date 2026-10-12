import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockDrug } from '@/mocks/handlers/drugs';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { drugKeys } from './hooks/use-drugs';
import { alwaysControlled } from './schemas';

const HEADING = { name: 'Drugs and consumables', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
/** Paracetamol tablet 5 mg, brand ParaCare, with a reorder level of 50. */
const PARACETAMOL = 'drg_h_2561';

const openList = async () => {
  const app = renderApp({ entry: '/drugs' });
  await screen.findAllByRole('link', { name: 'Aceclofenac' });
  return app;
};
const openDrug = async (id = PARACETAMOL) => {
  const app = renderApp({ entry: `/drugs/${id}` });
  await screen.findByRole('heading', { name: 'Details' });
  return app;
};
const openCreate = async () => {
  const app = renderApp({ entry: '/drugs/new' });
  await screen.findByRole('heading', { name: 'Add an item' });
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const textbox = (name: RegExp) => screen.getByRole('textbox', { name });
const choose = (name: RegExp, option: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name }), option);
const search = (text: string) =>
  userEvent.type(screen.getByRole('searchbox', { name: 'Search drugs and consumables' }), text);

async function type(name: RegExp, text: string) {
  await userEvent.clear(textbox(name));
  if (text) await userEvent.type(textbox(name), text);
}

/** Fills the add form with a medicine. */
async function fill(genericName: string, brand = '', strength = '') {
  await choose(/^Type/, 'Medicine');
  await type(/^Generic name/, genericName);
  if (brand) await type(/^Brand/, brand);
  await choose(/^Form/, 'Tablet');
  if (strength) await type(/^Strength/, strength);
  await choose(/^Tax class/, 'Reduced rate');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the catalog', () => {
  it('lists a large catalog a page at a time, by generic name', async () => {
    await openList();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('3210 items'));
    // One page, not three thousand rows.
    expect(screen.getAllByRole('link', { name: 'Aceclofenac' })).toHaveLength(25);
    expect(screen.queryByRole('link', { name: 'Paracetamol' })).not.toBeInTheDocument();

    await userEvent.click(button('Load more'));
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'Aceclofenac' })).toHaveLength(50),
    );
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Drugs and consumables' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('searches the generic name and the brand on the server, each word in any order', async () => {
    await openList();
    await search('paracetamol');
    await waitFor(() => expect(statuses()).toContain('80 items'));
    expect(screen.getAllByRole('link', { name: 'Paracetamol' })).toHaveLength(25);

    await search(' paracare');
    await waitFor(() => expect(statuses()).toContain('20 items'));

    await userEvent.clear(screen.getByRole('searchbox'));
    await search('nothing like this');
    expect(await screen.findByText('No item matches these filters.')).toBeInTheDocument();
  });

  it('narrows by type, form, schedule and to controlled drugs', async () => {
    await openList();
    await choose(/^Type/, 'Consumable');
    await waitFor(() => expect(statuses()).toContain('10 items'));
    expect(screen.getByRole('link', { name: 'Examination gloves' })).toBeInTheDocument();

    await choose(/^Type/, 'Medicines and consumables');
    await choose(/^Form/, 'Syrup');
    await waitFor(() => expect(statuses()).toContain('800 items'));

    await choose(/^Form/, 'All forms');
    await choose(/^Schedule/, 'Narcotic or psychotropic');
    await waitFor(() => expect(statuses()).toContain('80 items'));
    expect(screen.getAllByRole('link', { name: 'Morphine' }).length).toBeGreaterThan(0);

    await choose(/^Schedule/, 'All schedules');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Controlled drugs only' }));
    await waitFor(() => expect(statuses()).toContain('160 items'));
  });

  it('shows the archived items only when asked', async () => {
    await openList();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived items' }));

    expect(await screen.findByRole('link', { name: 'Withdrawn syrup' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 archived item'));
  });
});

describe('adding an item', () => {
  it('adds a medicine nothing like which is in the list, and opens it', async () => {
    const { router } = await openCreate();
    await fill('Zolpidem', 'ZolpRest', '10 mg');
    await type(/^Unit/, 'strip of 10');
    await choose(/^Drug schedule/, 'Schedule X');
    await type(/^Reorder level/, '20');
    await userEvent.click(button('Add item'));

    expect(await screen.findByRole('heading', { name: 'Zolpidem' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/drugs/drg_new_1');
    // Schedule X is controlled whether or not the box was ticked.
    expect(screen.getByText('Controlled drug')).toBeInTheDocument();
    expect(screen.getByText('ZolpRest · Tablet · 10 mg')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(alwaysControlled('x') && alwaysControlled('narcotic') && !alwaysControlled('h')).toBe(
      true,
    );
  });

  it('adds a consumable, which has no strength or schedule to give', async () => {
    await openCreate();
    await choose(/^Type/, 'Consumable');
    await type(/^Generic name/, 'Crepe bandage');
    await choose(/^Form/, 'Device or supply');
    await choose(/^Tax class/, 'Standard rate');
    await userEvent.click(button('Add item'));

    expect(await screen.findByRole('heading', { name: 'Crepe bandage' })).toBeInTheDocument();
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
  });

  it('needs a type, a name, a form and a tax class, and a reorder level that is a number', async () => {
    let sent = 0;
    server.use(
      http.post('*/api/drugs/duplicate-check', () => {
        sent++;
        return HttpResponse.json({ items: [] });
      }),
    );
    await openCreate();
    await userEvent.click(button('Add item'));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(4);

    await fill('Zolpidem');
    await type(/^Reorder level/, 'many');
    await userEvent.click(button('Add item'));
    await waitFor(() => expect(textbox(/^Reorder level/)).toHaveAttribute('aria-invalid', 'true'));
    expect(sent).toBe(0);
  });

  it('warns when the list has items like it, and adds it only when asked to', async () => {
    await openCreate();
    await fill('paracetamol', 'NewBrand', '500 mg');
    await userEvent.click(button('Add item'));

    // The same generic name in the same form, in other brands and strengths.
    const warning = await screen.findByRole('heading', {
      name: '10 items like this are already in the list',
    });
    expect(warning).toHaveFocus();
    expect(screen.getAllByText(/ParaCare · Tablet/).length).toBeGreaterThan(0);

    await userEvent.click(button('Add it anyway'));
    expect(await screen.findByRole('heading', { name: 'paracetamol' })).toBeInTheDocument();
    expect(screen.getByText('NewBrand · Tablet · 500 mg')).toBeInTheDocument();
  });

  it('goes back to the form with what was typed', async () => {
    await openCreate();
    await fill('Paracetamol', 'NewBrand', '500 mg');
    await userEvent.click(button('Add item'));
    await userEvent.click(await screen.findByRole('button', { name: 'Go back and change it' }));

    expect(textbox(/^Generic name/)).toHaveValue('Paracetamol');
    expect(textbox(/^Brand/)).toHaveValue('NewBrand');
    const added = await api.GET('/drugs', { params: { query: { q: 'NewBrand' } } });
    expect(added.data?.items).toEqual([]);
  });

  it('refuses exactly the item the hospital already has, whatever the capitals', async () => {
    await openCreate();
    await fill('PARACETAMOL', 'paracare', '5 MG');
    await userEvent.click(button('Add item'));
    await userEvent.click(await screen.findByRole('button', { name: 'Add it anyway' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This hospital already has exactly this item',
    );
    // Back on the form, with what was typed.
    expect(textbox(/^Brand/)).toHaveValue('paracare');
  });

  it('adds nothing when the screen is left while the check is on its way', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let created = 0;
    server.use(
      http.post('*/api/drugs/duplicate-check', async () => {
        await held;
        return HttpResponse.json({ items: [] });
      }),
      http.post('*/api/drugs', () => {
        created++;
        return undefined;
      }),
    );
    const { router } = await openCreate();
    await fill('Zolpidem');
    await userEvent.click(button('Add item'));
    await userEvent.click(screen.getByRole('link', { name: 'Cancel' }));
    await screen.findByRole('heading', HEADING);
    release();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(created).toBe(0);
    expect(router.state.location.pathname).toBe('/drugs');
  });

  it('shows a controlled schedule as controlled, with nothing to untick', async () => {
    await openCreate();
    expect(
      screen.getByRole('checkbox', { name: /Handled as a controlled drug/ }),
    ).not.toBeChecked();

    await choose(/^Drug schedule/, 'Narcotic or psychotropic');
    expect(screen.queryByRole('checkbox', { name: /Handled as a controlled drug/ })).toBeNull();
    expect(screen.getByText('yes, always for this schedule.')).toBeInTheDocument();

    await choose(/^Drug schedule/, 'Schedule H');
    expect(
      screen.getByRole('checkbox', { name: /Handled as a controlled drug/ }),
    ).toBeInTheDocument();
  });

  it('sends no empty fields with a new item, and one item for the same request sent twice', async () => {
    const bodies: Record<string, unknown>[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/api/drugs')) {
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body as Record<string, unknown>));
      }
    });
    await openCreate();
    await fill('Zolpidem');
    await userEvent.click(button('Add item'));
    await screen.findByRole('heading', { name: 'Zolpidem' });

    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual([
      'controlled',
      'form',
      'genericName',
      'schedule',
      'taxClass',
      'type',
    ]);
    server.events.removeAllListeners();

    // The same request again with the same key is the same item, not a refusal of its own copy.
    const body = {
      type: 'medicine',
      genericName: 'Repeat',
      form: 'tablet',
      schedule: 'none',
      taxClass: 'exempt',
    } as const;
    const params = { header: { 'Idempotency-Key': 'repeat-key-0001' } };
    const first = await api.POST('/drugs', { body, params });
    const again = await api.POST('/drugs', { body, params });
    expect(again.data?.id).toBe(first.data?.id);
    expect(again.response.headers.get('idempotent-replayed')).toBe('true');
  });

  it('adds nothing when the check for duplicates fails', async () => {
    let created = 0;
    server.use(
      http.post('*/api/drugs/duplicate-check', () => new HttpResponse(null, { status: 500 })),
      http.post('*/api/drugs', () => {
        created++;
        return undefined;
      }),
    );
    await openCreate();
    await fill('Zolpidem');
    await userEvent.click(button('Add item'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(created).toBe(0);
  });
});

describe('an item', () => {
  it('shows what it is', async () => {
    await openDrug();

    expect(screen.getByRole('heading', { name: 'Paracetamol' })).toBeInTheDocument();
    expect(screen.getByText('ParaCare · Tablet · 5 mg')).toBeInTheDocument();
    expect(screen.getByText('strip of 10')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.queryByText('Controlled drug')).not.toBeInTheDocument();
  });

  it('sends only what was changed, and takes a reorder level away when it is cleared', async () => {
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH')
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body));
    });
    await openDrug();
    await userEvent.click(button('Edit details'));
    await type(/^Unit/, 'strip of 15');
    await type(/^Reorder level/, '');
    await userEvent.click(button('Save item'));

    await waitFor(() => expect(statuses()).toContain('The item was saved.'));
    expect(bodies).toEqual([{ unit: 'strip of 15', reorderLevel: null, expectedVersion: 1 }]);
    expect(await screen.findByText('strip of 15')).toBeInTheDocument();
    expect(screen.queryByText('50')).not.toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it('keeps what was typed after a conflict, and shows what the other person saved in the same field', async () => {
    await openDrug();
    await userEvent.click(button('Edit details'));
    // Someone else changes the unit, and the schedule, meanwhile.
    editMockDrug(PARACETAMOL, { unit: 'strip of 20', schedule: 'h' });
    await type(/^Unit/, 'strip of 15');
    await userEvent.click(button('Save item'));

    expect(await screen.findByText(/Someone else changed this item/)).toBeInTheDocument();
    expect(textbox(/^Unit/)).toHaveValue('strip of 15');
    expect(await screen.findByText('Unit: strip of 20')).toBeInTheDocument();

    await waitFor(() => expect(button('Save item')).toBeEnabled());
    await userEvent.click(button('Save item'));
    await waitFor(() => expect(statuses()).toContain('The item was saved.'));
    expect(await screen.findByText('strip of 15')).toBeInTheDocument();
    // Only the unit was sent: their schedule is still there.
    expect(screen.getByText('Schedule H')).toBeInTheDocument();
  });

  it('puts what the other person saved into the fields that were not touched', async () => {
    await openDrug();
    await userEvent.click(button('Edit details'));
    editMockDrug(PARACETAMOL, { schedule: 'h' });
    await type(/^Unit/, 'strip of 15');
    await userEvent.click(button('Save item'));
    await screen.findByText(/Someone else changed this item/);

    // The form now shows their schedule, not the one it opened with, and keeps the typed unit.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^Drug schedule/ })).toHaveValue('h'),
    );
    expect(textbox(/^Unit/)).toHaveValue('strip of 15');
  });

  it('can be saved again when the item could not be read after a conflict', async () => {
    await openDrug();
    await userEvent.click(button('Edit details'));
    editMockDrug(PARACETAMOL, { schedule: 'h' });
    await type(/^Unit/, 'strip of 15');
    server.use(
      http.get('*/api/drugs/:id', () => new HttpResponse(null, { status: 500 }), { once: true }),
    );
    await userEvent.click(button('Save item'));
    await screen.findByText(/Someone else changed this item/);

    // Not left waiting for ever: Save comes back, and the next try reads the item again.
    await waitFor(() => expect(button('Save item')).toBeEnabled());
    expect(button('Cancel')).toBeEnabled();
  });

  it('sends what a schedule makes of the controlled flag along with the schedule', async () => {
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH')
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body));
    });
    await openDrug();
    await userEvent.click(button('Edit details'));
    await choose(/^Drug schedule/, 'Schedule X');
    await userEvent.click(button('Save item'));

    await waitFor(() => expect(statuses()).toContain('The item was saved.'));
    expect(bodies).toEqual([{ schedule: 'x', controlled: true, expectedVersion: 1 }]);
    expect(await screen.findByText('Controlled drug')).toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it('does not let a change make it the same as another item', async () => {
    await openDrug();
    await userEvent.click(button('Edit details'));
    // Paracetamol tablet 10 mg of the same brand is already in the list.
    await type(/^Strength/, '10 mg');
    await userEvent.click(button('Save item'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Another item of this hospital already has that generic name, brand, form and strength.',
    );
    expect(textbox(/^Strength/)).toHaveValue('10 mg');
  });

  it('archives and restores', async () => {
    await openDrug();
    await userEvent.click(button('Archive'));
    await waitFor(() => expect(statuses()).toContain('Paracetamol was archived.'));
    expect(await screen.findByText('Archived')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(statuses()).toContain('Paracetamol was restored.'));
    await waitFor(() => expect(screen.queryByText('Archived')).not.toBeInTheDocument());
  });

  it('has one answer for an item that does not exist and one of another hospital', async () => {
    renderApp({ entry: '/drugs/drg_c_1' });

    expect(await screen.findByRole('heading', { name: 'Item not found' })).toBeInTheDocument();
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
      http.get('*/api/drugs', () => {
        asked++;
        return undefined;
      }),
    );
    renderApp({ entry: '/drugs' });

    expect(
      await screen.findByRole('heading', { name: 'This screen needs a wider display' }),
    ).toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

describe('access', () => {
  it('lets someone who may only read see the catalog, with nothing to change it', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openList();
    expect(screen.queryByRole('link', { name: 'Add an item' })).not.toBeInTheDocument();

    renderApp({ entry: `/drugs/${PARACETAMOL}` });
    await screen.findByRole('heading', { name: 'Paracetamol' });
    expect(screen.queryByRole('button', { name: /Edit details|Archive/ })).toBeNull();
  });

  it('keeps the add screen from someone who may only read', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/drugs/new' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const path = { drugId: PARACETAMOL };

    await expect(
      api.POST('/drugs', {
        body: {
          type: 'medicine',
          genericName: 'X',
          form: 'tablet',
          schedule: 'none',
          taxClass: 'exempt',
        },
        params: { header: { 'Idempotency-Key': 'test-key-0001' } },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.POST('/drugs/duplicate-check', { body: { genericName: 'X', form: 'tablet' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.PATCH('/drugs/{drugId}', { params: { path }, body: { unit: 'x', expectedVersion: 1 } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.POST('/drugs/{drugId}/archive', { params: { path } })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'drug:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/drugs' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Drugs and consumables' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'drugs', false);
    renderApp({ entry: '/drugs' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Drugs and consumables' })).not.toBeInTheDocument();
    await expect(api.GET('/drugs', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s catalog in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: drugKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: drugKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/drugs');
    expect(await screen.findByRole('link', { name: 'Surgical mask' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('3 items'));
    expect(screen.queryByRole('link', { name: 'Aceclofenac' })).not.toBeInTheDocument();
  });

  it('cannot read or change another hospital’s item, and is not told of its duplicates', async () => {
    // The admin belongs to the hospital only. A clinic item does not exist for them.
    const path = { drugId: 'drg_c_1' };
    await expect(api.GET('/drugs/{drugId}', { params: { path } })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      api.PATCH('/drugs/{drugId}', { params: { path }, body: { unit: 'x', expectedVersion: 1 } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(api.POST('/drugs/{drugId}/archive', { params: { path } })).rejects.toMatchObject({
      code: 'not_found',
    });
    // Both hospitals keep surgical masks: only the hospital's own is a possible duplicate.
    const found = await api.POST('/drugs/duplicate-check', {
      body: { genericName: 'surgical mask', form: 'device' },
    });
    expect(found.data?.items.map((item) => item.tenantId)).toEqual([TENANT_IDS.hospital]);
  });
});
