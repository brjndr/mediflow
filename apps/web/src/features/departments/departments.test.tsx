import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockDepartment } from '@/mocks/handlers/departments';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { departmentKeys } from './hooks/use-departments';

const HEADING = { name: 'Departments', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const open = async () => {
  const app = renderApp({ entry: '/departments' });
  await screen.findByText('Cardiology');
  return app;
};
// The screen's own, not the header's (the hospital switcher has one too).
const status = () => within(screen.getByRole('main')).getByRole('status').textContent;
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const showArchived = () =>
  userEvent.click(screen.getByRole('checkbox', { name: 'Show archived departments' }));

async function fill(label: RegExp, text: string) {
  const field = screen.getByRole('textbox', { name: label });
  await userEvent.clear(field);
  if (text) await userEvent.type(field, text);
}

describe('the department list', () => {
  it('lists the hospital’s departments by name, a page at a time', async () => {
    await open();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    expect(status()).toBe('28 departments');
    // The first page of 25, in name order: the last three wait for "Load more".
    expect(screen.getByText('Anaesthesiology')).toBeInTheDocument();
    expect(screen.queryByText('Urology')).not.toBeInTheDocument();
    expect(screen.queryByText('Homeopathy')).not.toBeInTheDocument();

    await userEvent.click(button('Load more'));
    expect(await screen.findByText('Urology')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Departments' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('shows the archived departments only when asked', async () => {
    await open();
    await showArchived();

    expect(await screen.findByText('Homeopathy')).toBeInTheDocument();
    expect(screen.queryByText('Cardiology')).not.toBeInTheDocument();
    expect(status()).toBe('1 archived department');
    // An archived department is restored, not edited, and none is added from here.
    expect(screen.queryByRole('button', { name: 'Add department' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });

  it('says so when the list cannot be loaded, and tries again', async () => {
    server.use(
      http.get('*/api/departments', () => new HttpResponse(null, { status: 500 }), { once: true }),
    );
    renderApp({ entry: '/departments' });

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Cardiology')).toBeInTheDocument();
  });
});

describe('adding a department', () => {
  it('adds it to the list', async () => {
    await open();
    await userEvent.click(button('Add department'));
    await fill(/^Name/, '  Audiology ');
    await fill(/^Description/, 'Hearing tests, second floor');
    await userEvent.click(button('Save department'));

    await waitFor(() => expect(status()).toBe('Audiology was added.'));
    expect(await screen.findByText('Audiology')).toBeInTheDocument();
    expect(screen.getByText('Hearing tests, second floor')).toBeInTheDocument();
    // The form has closed.
    expect(screen.queryByRole('button', { name: 'Save department' })).not.toBeInTheDocument();
  });

  it('keeps the keyboard’s place: into the form, then to what happened when it closes', async () => {
    await open();
    await userEvent.click(button('Add department'));
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveFocus();
    await userEvent.click(button('Cancel'));
    const line = within(screen.getByRole('main')).getByRole('status');
    expect(line).toHaveFocus();

    await userEvent.click(button('Add department'));
    await userEvent.keyboard('Speech therapy{Enter}');
    await waitFor(() => expect(status()).toBe('Speech therapy was added.'));
    expect(line).toHaveFocus();
    await expectNoAxeViolations();
  });

  it('needs a name, and sends nothing without one', async () => {
    let sent = 0;
    server.use(
      http.post('*/api/departments', () => {
        sent++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await open();
    await userEvent.click(button('Add department'));
    await fill(/^Name/, '   ');
    await userEvent.click(button('Save department'));

    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    expect(sent).toBe(0);
  });

  it('refuses a pasted character that cannot be seen, and says which field', async () => {
    let sent = 0;
    server.use(
      http.post('*/api/departments', () => {
        sent++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await open();
    await userEvent.click(button('Add department'));
    // A zero-width space, as a name copied from a document can carry.
    await fill(/^Name/, `Renal${String.fromCodePoint(0x200b)}Unit`);
    await userEvent.click(button('Save department'));

    expect(
      await screen.findByText(
        'This text has a character that cannot be seen. Type it again instead of pasting it.',
      ),
    ).toBeInTheDocument();
    expect(sent).toBe(0);
  });

  it('refuses a name the hospital already uses, and keeps what was typed', async () => {
    await open();
    await userEvent.click(button('Add department'));
    await fill(/^Name/, 'cardiology');
    await userEvent.click(button('Save department'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This hospital already has a department with that name. It may be archived.',
    );
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('cardiology');
  });

  it('sends the same key when the same department is sent again, and a new one when it is edited', async () => {
    const sent: { name: string; key: string | null }[] = [];
    let failures = 1;
    server.use(
      http.post('*/api/departments', async ({ request }) => {
        const body = (await request.clone().json()) as { name: string };
        sent.push({ name: body.name, key: request.headers.get('idempotency-key') });
        if (failures-- > 0) return new HttpResponse(null, { status: 500 });
        return undefined;
      }),
    );
    await open();
    await userEvent.click(button('Add department'));
    await fill(/^Name/, 'Audiology');
    await userEvent.click(button('Save department'));
    await screen.findByRole('alert');
    // The answer was lost: the same thing is sent again, as the same request.
    await userEvent.click(button('Save department'));
    await waitFor(() => expect(status()).toBe('Audiology was added.'));

    await userEvent.click(button('Add department'));
    await fill(/^Name/, 'Speech Therapy');
    await userEvent.click(button('Save department'));
    await waitFor(() => expect(status()).toBe('Speech Therapy was added.'));

    expect(sent.map((request) => request.name)).toEqual([
      'Audiology',
      'Audiology',
      'Speech Therapy',
    ]);
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]?.key).toBe(sent[0]?.key);
    expect(sent[2]?.key).not.toBe(sent[0]?.key);
  });

  it('closes without saving on Cancel', async () => {
    await open();
    await userEvent.click(button('Add department'));
    await fill(/^Name/, 'Audiology');
    await userEvent.click(button('Cancel'));

    expect(screen.queryByRole('textbox', { name: /^Name/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Audiology')).not.toBeInTheDocument();
    expect(button('Add department')).toBeInTheDocument();
  });
});

describe('changing a department', () => {
  it('saves a new name', async () => {
    await open();
    await userEvent.click(button('Edit: Cardiology'));
    expect(screen.getByRole('heading', { name: 'Edit Cardiology' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Cardiology');

    await fill(/^Name/, 'Cardiac Sciences');
    await userEvent.click(button('Save department'));

    await waitFor(() => expect(status()).toBe('Cardiac Sciences was saved.'));
    expect(await screen.findByText('Cardiac Sciences')).toBeInTheDocument();
    expect(screen.queryByText('Cardiology')).not.toBeInTheDocument();
  });

  it('does not overwrite what someone else saved meanwhile', async () => {
    await open();
    await userEvent.click(button('Edit: Cardiology'));
    editMockDepartment('dep_h_02', { name: 'Heart Centre' });

    await fill(/^Name/, 'Cardiac Sciences');
    await userEvent.click(button('Save department'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Someone else changed this department while you were editing/,
    );
    // The list now shows what they saved, and the stale form is gone.
    expect(await screen.findByText('Heart Centre')).toBeInTheDocument();
    expect(screen.queryByText('Cardiac Sciences')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save department' })).not.toBeInTheDocument();
  });

  it('lets nothing else start while a save is on its way', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.patch(
        '*/api/departments/:id',
        async () => {
          await held;
          return undefined;
        },
        { once: true },
      ),
    );
    await open();
    await userEvent.click(button('Edit: Cardiology'));
    await fill(/^Name/, 'Cardiac Sciences');
    await userEvent.click(button('Save department'));

    // Another edit, an archive or the other list would overtake the save and lose its answer.
    await waitFor(() => expect(button('Edit: Dentistry')).toBeUnavailable());
    expect(button('Archive: Dentistry')).toBeUnavailable();
    expect(screen.getByRole('checkbox', { name: 'Show archived departments' })).toBeDisabled();

    release();
    await waitFor(() => expect(status()).toBe('Cardiac Sciences was saved.'));
    expect(button('Edit: Dentistry')).not.toBeUnavailable();
  });

  it('archives a department and restores it', async () => {
    await open();
    await userEvent.click(button('Archive: Cardiology'));

    await waitFor(() => expect(status()).toBe('Cardiology was archived.'));
    await waitFor(() => expect(screen.queryByText('Cardiology')).not.toBeInTheDocument());

    await showArchived();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore: Cardiology' }));
    await waitFor(() => expect(status()).toBe('Cardiology was restored.'));
    await waitFor(() => expect(screen.queryByText('Cardiology')).not.toBeInTheDocument());

    await showArchived();
    expect(await screen.findByText('Cardiology')).toBeInTheDocument();
  });

  it('says so when archiving fails, and leaves the department listed', async () => {
    server.use(
      http.post('*/api/departments/:id/archive', () => new HttpResponse(null, { status: 500 })),
    );
    await open();
    await userEvent.click(button('Archive: Cardiology'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Cardiology')).toBeInTheDocument();
  });
});

describe('access', () => {
  it('lets someone who may only read see the list, with nothing to change it', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await open();

    expect(screen.queryByRole('button', { name: 'Add department' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Edit|Archive)/ })).not.toBeInTheDocument();
    await showArchived();
    await screen.findByText('Homeopathy');
    expect(screen.queryByRole('button', { name: /^Restore/ })).not.toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);

    await expect(api.POST('/departments', { body: { name: 'Audiology' } })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      api.POST('/departments/{departmentId}/archive', {
        params: { path: { departmentId: 'dep_h_02' } },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'department:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/departments' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Departments' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'departments', false);
    renderApp({ entry: '/departments' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('heading', HEADING)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Departments' })).not.toBeInTheDocument();
    await expect(api.GET('/departments', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s departments in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await open();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: departmentKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: departmentKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/departments');
    expect(await screen.findByText('Family Medicine')).toBeInTheDocument();
    expect(status()).toBe('2 departments');
    expect(screen.queryByText('Cardiology')).not.toBeInTheDocument();
  });

  it('cannot change another hospital’s department', async () => {
    // The admin belongs to the hospital only. A clinic department does not exist for them.
    await expect(
      api.PATCH('/departments/{departmentId}', {
        params: { path: { departmentId: 'dep_c_01' } },
        body: { name: 'Taken over', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      api.POST('/departments/{departmentId}/archive', {
        params: { path: { departmentId: 'dep_c_01' } },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('may use a name another hospital uses', async () => {
    // The clinic has its own Paediatrics. Names are unique per hospital, not across them.
    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    await expect(
      api.POST('/departments', { body: { name: 'Family Medicine' } }),
    ).resolves.toMatchObject({ data: { name: 'Family Medicine', tenantId: TENANT_IDS.hospital } });
  });
});
