import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockService } from '@/mocks/handlers/services';
import {
  editMockBed,
  editMockBedCategory,
  editMockWard,
  setMockBedStatus,
} from '@/mocks/handlers/wards';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { wardKeys } from './hooks/use-wards';

const HEADING = { name: 'Wards and beds', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
/** General ward A: two halls of twelve beds, with beds occupied, being cleaned and blocked. */
const GWA = 'ward_h_gw-a';
/** A ward of two halls of four beds, all available. */
const W07 = 'ward_h_w-07';

const openList = async () => {
  const app = renderApp({ entry: '/wards' });
  await screen.findByRole('link', { name: 'General ward A' });
  return app;
};
const openWard = async (id = GWA) => {
  const app = renderApp({ entry: `/wards/${id}` });
  await screen.findByRole('heading', { name: 'Rooms and beds' });
  return app;
};
const openCreate = async () => {
  const app = renderApp({ entry: '/wards/new' });
  await screen.findByRole('heading', { name: 'Add a ward' });
  return app;
};
const openCategories = async () => {
  const app = renderApp({ entry: '/wards/categories' });
  await screen.findByText('Intensive care');
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const textbox = (name: RegExp) => screen.getByRole('textbox', { name });
const choose = (name: RegExp, option: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name }), option);
/** The row, or the card, of a bed or a category, by the text that names it. */
const row = (name: string) => {
  const cell = screen.getAllByText(name).find((element) => element.closest('tr, li'));
  return within(cell?.closest('tr, li') as HTMLElement);
};

async function type(name: RegExp, text: string) {
  await userEvent.clear(textbox(name));
  if (text) await userEvent.type(textbox(name), text);
}

/** The bodies of the requests of a method, as they were sent. */
function sent(method: string): unknown[] {
  const bodies: unknown[] = [];
  server.events.on('request:start', ({ request }) => {
    // A search is a POST too, and is not what these tests look at.
    if (request.method === method && !request.url.endsWith('/search'))
      void request
        .clone()
        .json()
        .then(
          (body) => bodies.push(body),
          () => bodies.push(null),
        );
  });
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

describe('the wards', () => {
  it('are listed a page at a time, by name, with their rooms and beds counted', async () => {
    await openList();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('30 wards'));
    const ward = row('General ward A');
    expect(ward.getByText('GW-A')).toBeInTheDocument();
    expect(ward.getByText('General Medicine')).toBeInTheDocument();
    // Two halls of twelve; the archived bed is not counted.
    expect(ward.getByText('2')).toBeInTheDocument();
    expect(ward.getByText('24')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ward 26' })).not.toBeInTheDocument();

    await userEvent.click(button('Load more'));
    expect(await screen.findByRole('link', { name: 'Ward 26' })).toBeInTheDocument();
  });

  it('are reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Wards and beds' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('are searched by code and name on the server, and the archived ones shown when asked', async () => {
    await openList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search wards' }), 'icu');
    await waitFor(() => expect(statuses()).toContain('1 ward'));
    expect(screen.getByRole('link', { name: 'Intensive care unit' })).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived wards' }));
    expect(await screen.findByRole('link', { name: 'Old annexe' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 archived ward'));
  });
});

describe('adding a ward', () => {
  it('adds a ward of a department, with no rooms yet, and opens it', async () => {
    const bodies = sent('POST');
    const { router } = await openCreate();
    await type(/^Code/, 'MAT');
    await type(/^Name/, 'Maternity ward');
    await type(/^Floor/, '1st floor');
    await screen.findByRole('option', { name: 'Obstetrics' });
    await choose(/^Department/, 'Obstetrics');
    await userEvent.click(button('Add ward'));

    expect(await screen.findByRole('heading', { name: 'Maternity ward' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/wards/ward_new_1');
    expect(screen.getByText('Obstetrics')).toBeInTheDocument();
    expect(screen.getByText('No rooms yet.')).toBeInTheDocument();
    expect(bodies).toEqual([
      { code: 'MAT', name: 'Maternity ward', floor: '1st floor', departmentId: 'dep_h_17' },
    ]);
  });

  it('needs a code and a name, and a code without spaces', async () => {
    const bodies = sent('POST');
    await openCreate();
    await userEvent.click(button('Add ward'));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(2);

    await type(/^Code/, 'not a code');
    await type(/^Name/, 'Maternity ward');
    await userEvent.click(button('Add ward'));
    await waitFor(() => expect(textbox(/^Code/)).toHaveAttribute('aria-invalid', 'true'));
    expect(bodies).toEqual([]);
  });

  it('says so when the hospital already has a ward with that code, and keeps what was typed', async () => {
    await openCreate();
    await type(/^Code/, 'gw-a');
    await type(/^Name/, 'Another general ward');
    await userEvent.click(button('Add ward'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This hospital already has a ward with that code. It may be archived.',
    );
    expect(textbox(/^Name/)).toHaveValue('Another general ward');
  });
});

describe('a ward', () => {
  it('shows its rooms, and for each bed its category and whether it can take a patient', async () => {
    await openWard();

    expect(screen.getByRole('heading', { name: 'General ward A' })).toBeInTheDocument();
    expect(screen.getByText('Ground floor')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hall 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hall 2' })).toBeInTheDocument();
    expect(row('GW-A-01').getByText('Occupied')).toBeInTheDocument();
    expect(row('GW-A-03').getByText('Being cleaned')).toBeInTheDocument();
    expect(row('GW-A-04').getByText('Blocked: Repair (Oxygen outlet)')).toBeInTheDocument();
    expect(row('GW-A-05').getByText('Available')).toBeInTheDocument();
    expect(row('GW-A-05').getByText('General ward')).toBeInTheDocument();

    // An archived bed is shown only when asked.
    expect(screen.queryByText('GW-A-99')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived rooms and beds' }));
    expect(row('GW-A-99').getByText('Archived')).toBeInTheDocument();
  });

  it('sends only what was changed', async () => {
    const bodies = sent('PATCH');
    await openWard();
    await userEvent.click(button('Edit details'));
    await type(/^Floor/, '');
    await userEvent.click(button('Save ward'));

    await waitFor(() => expect(statuses()).toContain('The ward was saved.'));
    // Empty text takes the floor away.
    expect(bodies).toEqual([{ floor: '', expectedVersion: 1 }]);
    expect(screen.queryByText('Ground floor')).not.toBeInTheDocument();
  });

  it('keeps what was typed after a conflict, and shows what the other person saved in the same field', async () => {
    await openWard();
    await userEvent.click(button('Edit details'));
    editMockWard(GWA, { floor: 'Basement', name: 'General ward Alpha' });
    await type(/^Floor/, 'Annexe');
    await userEvent.click(button('Save ward'));

    expect(await screen.findByText(/Someone else changed this ward/)).toBeInTheDocument();
    expect(textbox(/^Floor/)).toHaveValue('Annexe');
    expect(await screen.findByText('Floor or block: Basement')).toBeInTheDocument();
    // Their name is in the field this person did not touch.
    await waitFor(() => expect(textbox(/^Name/)).toHaveValue('General ward Alpha'));

    await waitFor(() => expect(button('Save ward')).toBeEnabled());
    await userEvent.click(button('Save ward'));
    await waitFor(() => expect(statuses()).toContain('The ward was saved.'));
    expect(screen.getByRole('heading', { name: 'General ward Alpha' })).toBeInTheDocument();
    expect(screen.getByText('Annexe')).toBeInTheDocument();
  });

  it('is not archived while a bed of it is occupied', async () => {
    await openWard();
    await userEvent.click(button('Archive ward'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A bed of this ward is occupied. The ward can be archived once its patients have left.',
    );
  });

  it('is archived with nothing left to change in it, and restored', async () => {
    await openWard(W07);
    expect(button('Add a room')).toBeInTheDocument();
    await userEvent.click(button('Archive ward'));

    await waitFor(() => expect(statuses()).toContain('Ward 07 was archived.'));
    expect(screen.getByText(/This ward is archived/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a room|Rename|^Block/ })).toBeNull();

    await userEvent.click(button('Restore ward'));
    await waitFor(() => expect(statuses()).toContain('Ward 07 was restored.'));
    expect(await screen.findByRole('button', { name: 'Add a room' })).toBeInTheDocument();
  });

  it('has one answer for a ward that does not exist and one of another hospital', async () => {
    renderApp({ entry: '/wards/ward_c_dc' });

    expect(await screen.findByRole('heading', { name: 'Ward not found' })).toBeInTheDocument();
  });
});

describe('rooms', () => {
  it('are added and renamed, and a name the ward has is refused with what was typed kept', async () => {
    const posts = sent('POST');
    const patches = sent('PATCH');
    await openWard(W07);
    await userEvent.click(button('Add a room'));
    await type(/^Room name/, 'hall 1');
    await userEvent.click(button('Add room'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This ward already has a room with that name. It may be archived.',
    );
    expect(textbox(/^Room name/)).toHaveValue('hall 1');

    await type(/^Room name/, 'Isolation room');
    await userEvent.click(button('Add room'));
    await waitFor(() => expect(statuses()).toContain('Isolation room was added.'));
    expect(screen.getByRole('heading', { name: 'Isolation room' })).toBeInTheDocument();
    expect(screen.getByText('No beds in this room.')).toBeInTheDocument();
    expect(posts).toEqual([{ name: 'hall 1' }, { name: 'Isolation room' }]);

    await userEvent.click(button('Rename Isolation room'));
    await type(/^Room name/, 'Side room');
    await userEvent.click(button('Save name'));
    await waitFor(() => expect(statuses()).toContain('The room is now Side room.'));
    expect(patches).toEqual([{ name: 'Side room', expectedVersion: 1 }]);
  });

  it('reuse a key for the same room sent again from the open form, and take a new one once the form is left', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post('*/api/wards/:wardId/rooms', ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await openWard(W07);
    await userEvent.click(button('Add a room'));
    await type(/^Room name/, 'Side room');
    await userEvent.click(button('Add room'));
    await screen.findByRole('alert');
    // The same room again, from the same form: one attempt.
    await userEvent.click(button('Add room'));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);

    // Left and opened again: a room of that name is now a new thing to add.
    await userEvent.click(button('Cancel'));
    await userEvent.click(button('Add a room'));
    await type(/^Room name/, 'Side room');
    await userEvent.click(button('Add room'));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('need a name', async () => {
    await openWard(W07);
    await userEvent.click(button('Add a room'));
    await userEvent.click(button('Add room'));

    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
  });

  it('are not archived while a bed in them is occupied', async () => {
    await openWard();
    await userEvent.click(button('Archive Hall 1'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A bed of this room is occupied. The room can be archived once its patients have left.',
    );
    expect(screen.getByRole('heading', { name: 'Hall 1' })).toBeInTheDocument();
  });

  it('are archived with their beds, and come back without them', async () => {
    await openWard(W07);
    await userEvent.click(button('Archive Hall 2'));
    await waitFor(() => expect(statuses()).toContain('Hall 2 and its beds were archived.'));
    expect(screen.queryByRole('heading', { name: /Hall 2/ })).not.toBeInTheDocument();
    expect(screen.queryByText('W-07-05')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived rooms and beds' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Hall 2' }));
    await waitFor(() =>
      expect(statuses()).toContain(
        'Hall 2 was restored. Its beds stay archived until each is restored.',
      ),
    );
    expect(row('W-07-05').getByText('Archived')).toBeInTheDocument();
    await userEvent.click(button('Restore: W-07-05'));
    await waitFor(() => expect(statuses()).toContain('Bed W-07-05 was restored.'));
    expect(row('W-07-05').getByText('Available')).toBeInTheDocument();
  });
});

describe('beds', () => {
  it('are added to a room with a number and a category, and a number the ward has is refused', async () => {
    const bodies = sent('POST');
    await openWard(W07);
    await userEvent.click(button('Add a bed to Hall 2'));
    await userEvent.click(button('Add bed'));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(2);

    await type(/^Bed number/, 'w-07-01');
    await choose(/^Bed category/, 'Private room');
    await userEvent.click(button('Add bed'));
    // The number is one in the ward, whatever the room and the capitals.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This ward already has a bed with that number. It may be archived.',
    );

    await type(/^Bed number/, 'W-07-09');
    await userEvent.click(button('Add bed'));
    await waitFor(() => expect(statuses()).toContain('Bed W-07-09 was added.'));
    expect(row('W-07-09').getByText('Private room')).toBeInTheDocument();
    expect(row('W-07-09').getByText('Available')).toBeInTheDocument();
    expect(bodies.at(-1)).toEqual({ number: 'W-07-09', bedCategoryId: 'bcat_h_private' });
    // An archived category is not offered for a bed.
    await userEvent.click(button('Add a bed to Hall 2'));
    expect(screen.queryByRole('option', { name: 'Deluxe suite' })).not.toBeInTheDocument();
  });

  it('send only what was changed', async () => {
    const bodies = sent('PATCH');
    await openWard(W07);
    await userEvent.click(button('Change: W-07-02'));
    await choose(/^Bed category/, 'Isolation');
    await userEvent.click(button('Save bed'));

    await waitFor(() => expect(statuses()).toContain('Bed W-07-02 was saved.'));
    expect(bodies).toEqual([{ bedCategoryId: 'bcat_h_isolation', expectedVersion: 1 }]);
    expect(row('W-07-02').getByText('Isolation')).toBeInTheDocument();
  });

  it('are blocked with a reason, and put back in use', async () => {
    const bodies = sent('POST');
    await openWard(W07);
    await userEvent.click(button('Block: W-07-03'));
    await userEvent.click(button('Block bed'));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    expect(bodies).toEqual([]);

    // The reason is one of a list, so nothing about a patient is written as the reason.
    await choose(/^Reason/, 'Deep cleaning');
    await userEvent.click(button('Block bed'));
    await waitFor(() => expect(statuses()).toContain('Bed W-07-03 is blocked.'));
    expect(row('W-07-03').getByText('Blocked: Deep cleaning')).toBeInTheDocument();
    expect(bodies).toEqual([{ reason: 'deep_cleaning' }]);

    await userEvent.click(button('Put back in use: W-07-03'));
    await waitFor(() => expect(statuses()).toContain('Bed W-07-03 is available again.'));
    expect(row('W-07-03').getByText('Available')).toBeInTheDocument();
  });

  it('offer only the changes their status allows: occupied and being cleaned are not set here', async () => {
    await openWard();

    // Occupied: admissions have it. Not blocked, not archived, not put back in use.
    expect(button('Block: GW-A-01')).toBeDisabled();
    expect(button('Archive: GW-A-01')).toBeDisabled();
    expect(button('Put back in use: GW-A-01')).toBeDisabled();
    // Being cleaned: housekeeping has it.
    expect(button('Block: GW-A-03')).toBeDisabled();
    expect(button('Put back in use: GW-A-03')).toBeDisabled();
    // Blocked: put back in use, not blocked twice.
    expect(button('Block: GW-A-04')).toBeDisabled();
    expect(button('Put back in use: GW-A-04')).toBeEnabled();
    // Available.
    expect(button('Block: GW-A-05')).toBeEnabled();
    expect(button('Put back in use: GW-A-05')).toBeDisabled();
    expect(button('Restore: GW-A-05')).toBeDisabled();
  });

  it('are not blocked when a patient was admitted to the bed meanwhile', async () => {
    await openWard(W07);
    await userEvent.click(button('Block: W-07-04'));
    await choose(/^Reason/, 'Repair');
    await type(/^Note/, 'Side rail');
    setMockBedStatus('ward_h_w-07_b4', 'occupied');
    await userEvent.click(button('Block bed'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an available bed can be blocked. This one is no longer available.',
    );
    // What is on screen is the bed as it now is.
    await waitFor(() => expect(row('W-07-04').getByText('Occupied')).toBeInTheDocument());
  });

  it('keep their status through archiving: a bed being cleaned comes back being cleaned', async () => {
    await openWard();
    await userEvent.click(button('Archive: GW-A-03'));
    await waitFor(() => expect(statuses()).toContain('Bed GW-A-03 was archived.'));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived rooms and beds' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore: GW-A-03' }));
    await waitFor(() => expect(statuses()).toContain('Bed GW-A-03 was restored.'));
    // Archiving is no way round housekeeping.
    expect(row('GW-A-03').getByText('Being cleaned')).toBeInTheDocument();
  });

  it('keep what was typed after a conflict, take what the other person saved elsewhere, and send only the change', async () => {
    const bodies = sent('PATCH');
    await openWard(W07);
    await userEvent.click(button('Change: W-07-02'));
    // Someone else gives the bed another number meanwhile.
    editMockBed('ward_h_w-07_b2', { number: 'W-07-2A' });
    await choose(/^Bed category/, 'Isolation');
    await userEvent.click(button('Save bed'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Someone else changed this while you were editing/,
    );
    // Their number is in the field this person did not touch; the chosen category stays.
    await waitFor(() => expect(textbox(/^Bed number/)).toHaveValue('W-07-2A'));
    expect(screen.getByRole('combobox', { name: /^Bed category/ })).toHaveValue('bcat_h_isolation');

    await userEvent.click(button('Save bed'));
    await waitFor(() => expect(statuses()).toContain('Bed W-07-2A was saved.'));
    // Their number was never sent back.
    expect(bodies).toEqual([
      { bedCategoryId: 'bcat_h_isolation', expectedVersion: 1 },
      { bedCategoryId: 'bcat_h_isolation', expectedVersion: 2 },
    ]);
    expect(row('W-07-2A').getByText('Isolation')).toBeInTheDocument();
  });

  it('start nothing else while a form is open, so an answer never lands on the wrong form', async () => {
    await openWard(W07);
    await userEvent.click(button('Block: W-07-03'));

    expect(button('Archive: W-07-01')).toBeDisabled();
    expect(button('Change: W-07-01')).toBeDisabled();
    expect(button('Archive Hall 1')).toBeDisabled();
    expect(button('Add a room')).toBeDisabled();
    await userEvent.click(button('Cancel'));
    expect(button('Archive: W-07-01')).toBeEnabled();
  });

  it('say so when the bed categories cannot be loaded, with a way to ask again', async () => {
    server.use(http.get('*/api/bed-categories', () => new HttpResponse(null, { status: 500 })));
    await openWard(W07);
    await userEvent.click(button('Add a bed to Hall 1'));

    expect(await screen.findByText('The bed categories could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/There is no bed category yet/)).not.toBeInTheDocument();
    server.resetHandlers();
    await userEvent.click(button('Try again'));
    expect(await screen.findByRole('combobox', { name: /^Bed category/ })).toBeInTheDocument();
  });

  it('are archived and restored', async () => {
    await openWard(W07);
    await userEvent.click(button('Archive: W-07-01'));
    await waitFor(() => expect(statuses()).toContain('Bed W-07-01 was archived.'));
    expect(screen.queryByText('W-07-01')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived rooms and beds' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore: W-07-01' }));
    await waitFor(() => expect(statuses()).toContain('Bed W-07-01 was restored.'));
  });

  it('are refused by the server whatever the screen offers', async () => {
    const path = { wardId: GWA, bedId: 'ward_h_gw-a_b1' };
    // An occupied bed is neither blocked nor archived, and a status is never set by hand.
    await expect(
      api.POST('/wards/{wardId}/beds/{bedId}/block', {
        params: { path },
        body: { reason: 'repair' },
      }),
    ).rejects.toMatchObject({ serverCode: 'bed_not_available' });
    await expect(
      api.POST('/wards/{wardId}/beds/{bedId}/archive', { params: { path } }),
    ).rejects.toMatchObject({ serverCode: 'bed_occupied' });
    await expect(
      api.POST('/wards/{wardId}/beds/{bedId}/unblock', { params: { path } }),
    ).rejects.toMatchObject({ serverCode: 'bed_not_blocked' });
    await expect(
      api.PATCH('/wards/{wardId}/beds/{bedId}', {
        params: { path },
        body: { status: 'available', expectedVersion: 1 } as never,
      }),
    ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    // A bed is reached through its own ward only.
    await expect(
      api.POST('/wards/{wardId}/beds/{bedId}/archive', {
        params: { path: { wardId: W07, bedId: 'ward_h_gw-a_b5' } },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // An archived bed is restored before it is changed, and a key is not carried to another route.
    await expect(
      api.PATCH('/wards/{wardId}/beds/{bedId}', {
        params: { path: { wardId: GWA, bedId: 'ward_h_gw-a_bold' } },
        body: { number: 'GW-A-98', expectedVersion: 2 },
      }),
    ).rejects.toMatchObject({ serverCode: 'bed_archived' });
    // Adding the same bed twice with one key adds one.
    const add = () =>
      api.POST('/wards/{wardId}/rooms/{roomId}/beds', {
        params: {
          path: { wardId: W07, roomId: 'ward_h_w-07_r1' },
          header: { 'idempotency-key': 'test-key-0001' },
        },
        body: { number: 'X-1', bedCategoryId: 'bcat_h_general' },
      });
    await add();
    const again = await add();
    expect(again.data?.ward.bedCount).toBe(9);
    await expect(
      api.POST('/wards/{wardId}/rooms/{roomId}/beds', {
        params: {
          path: { wardId: W07, roomId: 'ward_h_w-07_r2' },
          header: { 'idempotency-key': 'test-key-0001' },
        },
        body: { number: 'X-1', bedCategoryId: 'bcat_h_general' },
      }),
    ).rejects.toMatchObject({ serverCode: 'idempotency_key_reuse' });
  });
});

describe('bed categories', () => {
  it('are listed with the bed-day service each is charged as and the beds that have it', async () => {
    await openCategories();

    expect(screen.getByRole('heading', { name: 'Bed categories', level: 1 })).toBeInTheDocument();
    expect(row('Intensive care').getByText('ICU bed day')).toBeInTheDocument();
    expect(row('Intensive care').getByText('8')).toBeInTheDocument();
    expect(row('General ward').getByText('General ward bed day')).toBeInTheDocument();
    expect(row('General ward').getByText('240')).toBeInTheDocument();
    // A category with no service says so: its beds would not be charged.
    expect(row('Isolation').getByText('Not linked: no bed-day charge')).toBeInTheDocument();
    expect(screen.queryByText('Deluxe suite')).not.toBeInTheDocument();
  });

  it('are reached from the wards', async () => {
    await openList();
    await userEvent.click(screen.getByRole('link', { name: 'Bed categories' }));

    expect(
      await screen.findByRole('heading', { name: 'Bed categories', level: 1 }),
    ).toBeInTheDocument();
  });

  it('are added with a bed-day service of the price catalog, and a name the hospital has is refused', async () => {
    const bodies = sent('POST');
    await openCategories();
    await userEvent.click(button('Add a bed category'));
    await userEvent.click(button('Add category'));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();

    await type(/^Name/, 'intensive care');
    await userEvent.click(button('Add category'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This hospital already has a bed category with that name. It may be archived.',
    );

    await type(/^Name/, 'High dependency');
    await screen.findByRole('option', { name: 'ICU bed day (BED-004)' });
    // Only bed-day services are offered.
    expect(screen.queryByRole('option', { name: /General consultation/ })).not.toBeInTheDocument();
    await choose(/^Charged as/, 'ICU bed day (BED-004)');
    await userEvent.click(button('Add category'));
    await waitFor(() => expect(statuses()).toContain('High dependency was added.'));
    expect(row('High dependency').getByText('ICU bed day')).toBeInTheDocument();
    expect(bodies.at(-1)).toEqual({ name: 'High dependency', serviceId: 'svc_h_15' });
  });

  it('are linked to a service and unlinked, sending only what was changed', async () => {
    const bodies = sent('PATCH');
    await openCategories();
    await userEvent.click(button('Change: Isolation'));
    await screen.findByRole('option', { name: 'Private room day (BED-003)' });
    await choose(/^Charged as/, 'Private room day (BED-003)');
    await userEvent.click(button('Save category'));
    await waitFor(() => expect(statuses()).toContain('Isolation was saved.'));
    expect(row('Isolation').getByText('Private room day')).toBeInTheDocument();

    await userEvent.click(button('Change: Isolation'));
    await choose(/^Charged as/, 'Not linked to a service');
    await userEvent.click(button('Save category'));
    await waitFor(() =>
      expect(row('Isolation').getByText('Not linked: no bed-day charge')).toBeInTheDocument(),
    );
    expect(bodies).toEqual([
      { serviceId: 'svc_h_14', expectedVersion: 1 },
      { serviceId: '', expectedVersion: 2 },
    ]);
  });

  it('keep what was typed after a conflict, and never send back what the other person changed', async () => {
    const bodies = sent('PATCH');
    await openCategories();
    await userEvent.click(button('Change: Private room'));
    await screen.findByRole('option', { name: 'Private room day (BED-003)' });
    // Someone else links the category to another service meanwhile.
    editMockBedCategory('bcat_h_private', { serviceId: 'svc_h_15' });
    await type(/^Name/, 'Private suite');
    await userEvent.click(button('Save category'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Someone else changed this while you were editing/,
    );
    expect(textbox(/^Name/)).toHaveValue('Private suite');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^Charged as/ })).toHaveValue('svc_h_15'),
    );

    await userEvent.click(button('Save category'));
    await waitFor(() => expect(statuses()).toContain('Private suite was saved.'));
    expect(bodies).toEqual([
      { name: 'Private suite', expectedVersion: 1 },
      { name: 'Private suite', expectedVersion: 2 },
    ]);
    // Their link is still there.
    expect(row('Private suite').getByText('ICU bed day')).toBeInTheDocument();
  });

  it('are not archived while beds in use have them, and are restored from the archived view', async () => {
    await openCategories();
    await userEvent.click(button('Archive: General ward'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Beds in use have this category. Give them another category first.',
    );

    await userEvent.click(button('Archive: Isolation'));
    await waitFor(() => expect(statuses()).toContain('Isolation was archived.'));
    await waitFor(() => expect(screen.queryByText('Isolation')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived categories' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore: Isolation' }));
    await waitFor(() => expect(statuses()).toContain('Isolation was restored.'));
  });

  it('take only a bed-day service of the same hospital', async () => {
    const add = (serviceId: string, key: string) =>
      api.POST('/bed-categories', {
        body: { name: `Category ${key}`, serviceId },
        params: { header: { 'idempotency-key': key } },
      });
    // A consultation is in the price catalog, and is not what a bed is charged as.
    await expect(add('svc_h_01', 'test-key-0001')).rejects.toMatchObject({
      serverCode: 'validation_failed',
    });
    // Nor a service of the clinic.
    await expect(add('svc_c_01', 'test-key-0002')).rejects.toMatchObject({
      serverCode: 'validation_failed',
    });
    // Nor one that has been archived: but a category keeps the one it has.
    editMockService('svc_h_14', { archived: true });
    await expect(add('svc_h_14', 'test-key-0003')).rejects.toMatchObject({
      serverCode: 'validation_failed',
    });
    const kept = await api.PATCH('/bed-categories/{bedCategoryId}', {
      params: { path: { bedCategoryId: 'bcat_h_private' } },
      body: { name: 'Private', serviceId: 'svc_h_14', expectedVersion: 1 },
    });
    expect(kept.data?.serviceName).toBe('Private room day');
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
      http.get('*/api/wards', () => {
        asked++;
        return undefined;
      }),
    );
    renderApp({ entry: '/wards' });

    expect(
      await screen.findByRole('heading', { name: 'This screen needs a wider display' }),
    ).toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

describe('access', () => {
  it('lets someone who may only read see the wards, beds and categories, with nothing to change them', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openList();
    expect(screen.queryByRole('link', { name: 'Add a ward' })).not.toBeInTheDocument();

    renderApp({ entry: `/wards/${GWA}` });
    await screen.findByRole('heading', { name: 'Hall 1' });
    expect(row('GW-A-04').getByText('Blocked: Repair (Oxygen outlet)')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Edit details|Archive|Add a|Rename|^Block|^Change/ }),
    ).toBeNull();

    renderApp({ entry: '/wards/categories' });
    await screen.findByText('Intensive care');
    expect(
      screen.queryByRole('button', { name: /Add a bed category|^Change|^Archive/ }),
    ).toBeNull();
  });

  it('keeps the add screen from someone who may only read', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/wards/new' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const key = { 'idempotency-key': 'test-key-0001' };
    const forbidden = { code: 'forbidden' };

    await expect(
      api.POST('/wards', { body: { code: 'X', name: 'X' }, params: { header: key } }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      api.PATCH('/wards/{wardId}', {
        params: { path: { wardId: GWA } },
        body: { name: 'x', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      api.POST('/wards/{wardId}/rooms', {
        params: { path: { wardId: GWA }, header: key },
        body: { name: 'x' },
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      api.POST('/wards/{wardId}/beds/{bedId}/block', {
        params: { path: { wardId: GWA, bedId: 'ward_h_gw-a_b5' } },
        body: { reason: 'repair' },
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      api.POST('/bed-categories', { body: { name: 'X' }, params: { header: key } }),
    ).rejects.toMatchObject(forbidden);
  });

  it('shows the linked service and does not ask for the price catalog at a hospital that has it off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'services', false);
    let asked = 0;
    server.use(
      http.post('*/api/services/search', () => {
        asked++;
        return undefined;
      }),
    );
    await openCategories();
    await userEvent.click(button('Change: Intensive care'));

    expect(
      screen.getByText(
        'The price catalog is not open to you, so the service cannot be changed here.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^Charged as/ })).not.toBeInTheDocument();
    expect(asked).toBe(0);
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'ward:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/wards' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Wards and beds' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'wards', false);
    renderApp({ entry: '/wards/categories' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Wards and beds' })).not.toBeInTheDocument();
    for (const path of ['/wards', '/bed-categories'] as const) {
      await expect(api.GET(path, { params: { query: {} } })).rejects.toMatchObject({
        code: 'forbidden',
        serverCode: 'feature_disabled',
      });
    }
  });
});

describe('two hospitals', () => {
  it('never show one hospital’s wards in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: wardKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: wardKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/wards');
    expect(await screen.findByRole('link', { name: 'Observation room' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 ward'));
    expect(screen.queryByRole('link', { name: 'General ward A' })).not.toBeInTheDocument();

    await router.navigate('/wards/categories');
    expect(await screen.findByText('Observation')).toBeInTheDocument();
    expect(screen.queryByText('Intensive care')).not.toBeInTheDocument();
  });

  it('cannot read, change or build on another hospital’s ward, bed or category', async () => {
    // The admin belongs to the hospital only. A clinic ward does not exist for them.
    const path = { wardId: 'ward_c_dc' };
    const gone = { code: 'not_found' };
    await expect(api.GET('/wards/{wardId}', { params: { path } })).rejects.toMatchObject(gone);
    await expect(
      api.PATCH('/wards/{wardId}', { params: { path }, body: { name: 'x', expectedVersion: 1 } }),
    ).rejects.toMatchObject(gone);
    await expect(api.POST('/wards/{wardId}/archive', { params: { path } })).rejects.toMatchObject(
      gone,
    );
    await expect(
      api.POST('/wards/{wardId}/rooms', {
        params: { path, header: { 'idempotency-key': 'test-key-0001' } },
        body: { name: 'x' },
      }),
    ).rejects.toMatchObject(gone);
    await expect(
      api.POST('/wards/{wardId}/beds/{bedId}/block', {
        params: { path: { ...path, bedId: 'ward_c_dc_b1' } },
        body: { reason: 'repair' },
      }),
    ).rejects.toMatchObject(gone);
    // Nor through a ward of their own: the clinic's room and bed are not in it.
    await expect(
      api.POST('/wards/{wardId}/rooms/{roomId}/archive', {
        params: { path: { wardId: GWA, roomId: 'ward_c_dc_r1' } },
      }),
    ).rejects.toMatchObject(gone);
    await expect(
      api.POST('/wards/{wardId}/beds/{bedId}/archive', {
        params: { path: { wardId: GWA, bedId: 'ward_c_dc_b1' } },
      }),
    ).rejects.toMatchObject(gone);
    await expect(
      api.PATCH('/bed-categories/{bedCategoryId}', {
        params: { path: { bedCategoryId: 'bcat_c_daycare' } },
        body: { name: 'x', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject(gone);
    // A bed of this hospital cannot be given the clinic's category, nor a ward its department.
    await expect(
      api.PATCH('/wards/{wardId}/beds/{bedId}', {
        params: { path: { wardId: GWA, bedId: 'ward_h_gw-a_b5' } },
        body: { bedCategoryId: 'bcat_c_daycare', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    await expect(
      api.PATCH('/wards/{wardId}', {
        params: { path: { wardId: GWA } },
        body: { departmentId: 'dep_c_01', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ serverCode: 'validation_failed' });
    // The same code is free at each hospital: the clinic has its own DC.
    const list = await api.GET('/wards', { params: { query: { q: 'dc' } } });
    expect(list.data?.items.map((item) => item.tenantId)).toEqual([TENANT_IDS.hospital]);
  });
});
