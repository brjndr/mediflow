import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockInvitesSent } from '@/mocks/handlers/staff';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { parseCsv, readInvites } from './csv';
import { staffKeys } from './hooks/use-staff';

const HEADING = { name: 'Staff', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const ROLES = [
  { id: 'admin', name: 'Admin' },
  { id: 'doctor', name: 'Doctor' },
];

const openList = async () => {
  const app = renderApp({ entry: '/staff' });
  await screen.findByText('Aarav Iyer');
  return app;
};
const openInvite = async () => {
  const app = renderApp({ entry: '/staff/invite' });
  await screen.findByRole('heading', { name: 'Invite one person' });
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const show = (view: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), view);
const csvFile = (text: string) => new File([text], 'staff.csv', { type: 'text/csv' });
const upload = (text: string) => userEvent.upload(screen.getByLabelText('CSV file'), csvFile(text));
const sentTo = () => mockInvitesSent().map((invite) => invite.email);

async function fillInvite(name: string, email: string, role?: string) {
  await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), name);
  await userEvent.type(screen.getByRole('textbox', { name: /^Email/ }), email);
  if (role) await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Role/ }), role);
}

describe('the staff list', () => {
  it('lists the active staff by name, a page at a time, and marks the person signed in', async () => {
    await openList();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('37 active members of staff'));
    expect(screen.queryByText('Zoya Sharma')).not.toBeInTheDocument();
    // Deactivated staff and open invitations are other views.
    expect(screen.queryByText('Meera Patel')).not.toBeInTheDocument();
    expect(screen.queryByText('Invited Ira')).not.toBeInTheDocument();

    await userEvent.click(button('Load more'));
    expect(await screen.findByText('Zoya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Sample Admin (you)')).toBeInTheDocument();
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Staff' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('searches by name or email on the server', async () => {
    await openList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'patel');
    await waitFor(() => expect(statuses()).toContain('3 active members of staff'));

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search staff' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'nobody@');
    expect(await screen.findByText('Nobody matches this search.')).toBeInTheDocument();
  });

  it('shows deactivated staff and open invitations as their own views', async () => {
    await openList();
    await show('Deactivated staff');
    expect(await screen.findByText('Meera Patel')).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 deactivated member of staff'));
    expect(screen.queryByText('Aarav Iyer')).not.toBeInTheDocument();

    await show('Open invitations');
    expect(await screen.findByText('Invited Ira')).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('1 open invitation'));
  });
});

describe('what an admin does to a member', () => {
  it('asks before deactivating, and does nothing on Cancel', async () => {
    await openList();
    await userEvent.click(button('Deactivate: Aarav Iyer'));

    const question = screen.getByRole('heading', { name: 'Deactivate Aarav Iyer?' });
    expect(question).toHaveFocus();
    await userEvent.click(button('Cancel'));

    expect(question).not.toBeInTheDocument();
    expect(screen.getByText('Aarav Iyer')).toBeInTheDocument();
  });

  it('deactivates someone, who can then be reactivated', async () => {
    await openList();
    await userEvent.click(button('Deactivate: Aarav Iyer'));
    await userEvent.click(button('Deactivate'));

    await waitFor(() => expect(statuses()).toContain('Aarav Iyer was deactivated.'));
    await waitFor(() => expect(screen.queryByText('Aarav Iyer')).not.toBeInTheDocument());

    await show('Deactivated staff');
    await userEvent.click(await screen.findByRole('button', { name: 'Reactivate: Aarav Iyer' }));
    await waitFor(() => expect(statuses()).toContain('Aarav Iyer is active again.'));
    await waitFor(() => expect(screen.queryByText('Aarav Iyer')).not.toBeInTheDocument());

    await show('Active staff');
    expect(await screen.findByText('Aarav Iyer')).toBeInTheDocument();
  });

  it('does not offer to deactivate the person signed in, and the server refuses it too', async () => {
    await openList();
    await userEvent.click(button('Load more'));
    await screen.findByText('Sample Admin (you)');

    expect(button('Deactivate: Sample Admin')).toBeDisabled();
    await expect(
      api.POST('/staff/{userId}/deactivate', { params: { path: { userId: USER_IDS.admin } } }),
    ).rejects.toMatchObject({ serverCode: 'cannot_deactivate_self' });
  });

  it('explains why the only person who can manage staff cannot be deactivated', async () => {
    server.use(
      http.post('*/api/staff/:id/deactivate', () =>
        HttpResponse.json({ error: { code: 'last_admin', message: 'x' } }, { status: 409 }),
      ),
    );
    await openList();
    await userEvent.click(button('Deactivate: Aarav Iyer'));
    await userEvent.click(button('Deactivate'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This is the only person who can manage staff here.',
    );
    expect(screen.getByText('Aarav Iyer')).toBeInTheDocument();
  });

  it('signs someone out everywhere', async () => {
    await openList();
    await userEvent.click(button('Sign out everywhere: Aarav Iyer'));

    await waitFor(() => expect(statuses()).toContain('Aarav Iyer was signed out everywhere.'));
    expect(screen.getByText('Aarav Iyer')).toBeInTheDocument();
  });

  it('sends an open invitation again', async () => {
    await openList();
    await show('Open invitations');
    await userEvent.click(await screen.findByRole('button', { name: 'Send again: Invited Ira' }));

    await waitFor(() =>
      expect(statuses()).toContain('The invitation to ira@sample-hospital.test was sent again.'),
    );
    expect(sentTo()).toEqual(['ira@sample-hospital.test']);
    // It replaces the older one: still one invitation open for that address.
    await waitFor(() => expect(screen.getAllByText('Invited Ira')).toHaveLength(1));
  });
});

describe('inviting one person', () => {
  it('sends the invitation and is ready for the next person in the same role', async () => {
    await openInvite();
    await fillInvite('Nina Nurse', ' Nina.Nurse@Sample-Hospital.test ', 'Doctor');
    await userEvent.click(button('Send invitation'));

    await waitFor(() =>
      expect(statuses()).toContain('An invitation was sent to nina.nurse@sample-hospital.test.'),
    );
    expect(sentTo()).toEqual(['nina.nurse@sample-hospital.test']);
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^Email/ })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /^Role/ })).toHaveValue('doctor');
  });

  it('needs a name, an address and a role, and sends nothing without', async () => {
    await openInvite();
    await userEvent.click(button('Send invitation'));
    expect(await screen.findAllByText('This field is required.')).toHaveLength(3);

    await fillInvite('Nina Nurse', 'not-an-address', 'Doctor');
    await userEvent.click(button('Send invitation'));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /^Email/ })).toHaveAttribute(
        'aria-invalid',
        'true',
      ),
    );
    expect(sentTo()).toEqual([]);
  });

  it('says so when the role was removed meanwhile, and keeps what was typed', async () => {
    server.use(
      http.post('*/api/invites', () =>
        HttpResponse.json({ error: { code: 'unknown_role', message: 'x' } }, { status: 400 }),
      ),
    );
    await openInvite();
    await fillInvite('Nina Nurse', 'nina@sample-hospital.test', 'Doctor');
    await userEvent.click(button('Send invitation'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That role no longer exists at this hospital.',
    );
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Nina Nurse');
  });
});

describe('inviting from a file', () => {
  const FILE = [
    'Name,Email,Role',
    'Asha Rao,asha.rao@sample-hospital.test,Doctor',
    '"Rao, Vikram",VIKRAM.RAO@sample-hospital.test,admin',
    'No Address,not-an-address,Doctor',
    'Wrong Role,wrong.role@sample-hospital.test,Wizard',
    'Asha Again,asha.rao@sample-hospital.test,Doctor',
  ].join('\r\n');

  it('shows every row and what is wrong with it before anything is sent', async () => {
    await openInvite();
    await upload(FILE);

    await waitFor(() =>
      expect(statuses()).toContain(
        '2 of 5 rows can be sent. 3 rows have a problem and will be left out.',
      ),
    );
    expect(screen.getByText('Rao, Vikram')).toBeInTheDocument();
    expect(screen.getByText('Not an email address')).toBeInTheDocument();
    expect(screen.getByText('No such role here')).toBeInTheDocument();
    expect(screen.getByText('The same address is on an earlier line')).toBeInTheDocument();
    expect(sentTo()).toEqual([]);
  });

  it('sends the rows that are in order', async () => {
    await openInvite();
    await upload(FILE);
    await userEvent.click(await screen.findByRole('button', { name: 'Send 2 invitations' }));

    await waitFor(() => expect(statuses()).toContain('2 invitations were sent.'));
    expect(sentTo()).toEqual(['asha.rao@sample-hospital.test', 'vikram.rao@sample-hospital.test']);
    expect(screen.getAllByText('Sent')).toHaveLength(2);
    // Nothing is left to send.
    expect(screen.queryByRole('button', { name: /^Send \d+ invitation/ })).not.toBeInTheDocument();
  });

  it('carries on past a row the server refuses, and says which', async () => {
    server.use(
      http.post('*/api/invites', async ({ request }) => {
        const body = (await request.clone().json()) as { email: string };
        return body.email.startsWith('asha')
          ? HttpResponse.json({ error: { code: 'unknown_role', message: 'x' } }, { status: 400 })
          : undefined;
      }),
    );
    await openInvite();
    await upload(FILE);
    await userEvent.click(await screen.findByRole('button', { name: 'Send 2 invitations' }));

    await waitFor(() =>
      expect(statuses()).toContain('1 invitation was sent. 1 could not be sent. See the list.'),
    );
    expect(sentTo()).toEqual(['vikram.rao@sample-hospital.test']);
    expect(screen.getByText('Not sent: No such role here')).toBeInTheDocument();
  });

  it('stops when the hospital is asked to slow down, and sends the rest later without repeats', async () => {
    // The client tries a 429 again by itself; this one keeps coming until the minute is over.
    let limited = true;
    server.use(
      http.post('*/api/invites', async ({ request }) => {
        const body = (await request.clone().json()) as { email: string };
        return limited && body.email.startsWith('vikram')
          ? HttpResponse.json(
              { error: { code: 'rate_limited', message: 'x' } },
              { status: 429, headers: { 'Retry-After': '0' } },
            )
          : undefined;
      }),
    );
    await openInvite();
    await upload(FILE);
    await userEvent.click(await screen.findByRole('button', { name: 'Send 2 invitations' }));

    expect(await screen.findByText(/Stopped: too many requests/)).toBeInTheDocument();
    expect(sentTo()).toEqual(['asha.rao@sample-hospital.test']);

    limited = false;
    await userEvent.click(await screen.findByRole('button', { name: 'Send 1 invitation' }));
    await waitFor(() => expect(statuses()).toContain('2 invitations were sent.'));
    expect(sentTo()).toEqual(['asha.rao@sample-hospital.test', 'vikram.rao@sample-hospital.test']);
  });

  it('refuses a file without the three columns, an empty one and one that is too long', async () => {
    await openInvite();
    await upload('person,address\nAsha,asha@sample-hospital.test');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The first row must name the columns: name, email, role.',
    );

    await upload('name,email,role\n');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The file has no people in it.'),
    );

    const many = Array.from({ length: 201 }, (_, n) => `P ${n},p${n}@sample-hospital.test,Doctor`);
    await upload(['name,email,role', ...many].join('\n'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The file has more than 200 people.'),
    );
  });

  it('reads CSV as spreadsheets write it', () => {
    expect(parseCsv('﻿a,b\r\n"x ""y"", z",2\n\n 3 ,4')).toEqual([
      ['a', 'b'],
      ['x "y", z', '2'],
      ['3', '4'],
    ]);
    // Columns in any order, and a role by its name or its id.
    expect(
      readInvites(
        'Role,Name,Email\nDOCTOR,Asha,Asha@Example.org\nadmin,Ben,ben@example.org',
        ROLES,
      ),
    ).toEqual({
      rows: [
        {
          line: 2,
          name: 'Asha',
          email: 'asha@example.org',
          role: 'DOCTOR',
          request: { name: 'Asha', email: 'asha@example.org', roleId: 'doctor' },
        },
        {
          line: 3,
          name: 'Ben',
          email: 'ben@example.org',
          role: 'admin',
          request: { name: 'Ben', email: 'ben@example.org', roleId: 'admin' },
        },
      ],
    });
  });
});

describe('access', () => {
  const readOnlyDoctor = () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'staff:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
  };

  it('lets someone who may only read see the list, with nothing to change it', async () => {
    readOnlyDoctor();
    await openList();

    expect(screen.queryByRole('link', { name: 'Invite staff' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Deactivate|Sign out everywhere)/ })).toBeNull();
    await show('Open invitations');
    await screen.findByText('Invited Ira');
    expect(screen.queryByRole('button', { name: /^Send again/ })).not.toBeInTheDocument();
  });

  it('keeps the invite screen from someone who may not invite', async () => {
    readOnlyDoctor();
    renderApp({ entry: '/staff/invite' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    readOnlyDoctor();
    const path = { userId: 'stf_h_01' };

    await expect(api.GET('/staff/roles')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.POST('/staff/{userId}/deactivate', { params: { path } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.POST('/staff/{userId}/revoke-sessions', { params: { path } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.POST('/invites', {
        body: { name: 'N', email: 'n@sample-hospital.test', roleId: 'doctor' },
        params: { header: { 'idempotency-key': 'test-key-0001' } },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('has no screen and no navigation entry without the permission', async () => {
    // A doctor holds none of the staff permissions.
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/staff' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Staff' })).not.toBeInTheDocument();
  });

  it('offers what a custom role holds, and no more', async () => {
    // Someone who may invite but not manage: the invite link, and no way to deactivate.
    revokePermission(TENANT_IDS.hospital, 'admin', 'staff:manage');
    await openList();

    expect(screen.getByRole('link', { name: 'Invite staff' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Deactivate|Sign out everywhere)/ })).toBeNull();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'staff', false);
    renderApp({ entry: '/staff' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Staff' })).not.toBeInTheDocument();
    await expect(api.GET('/staff', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s staff in the other', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'staff:read');
    grantPermission(TENANT_IDS.clinic, 'doctor', 'staff:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: staffKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: staffKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/staff');
    expect(await screen.findByText('Sample Receptionist')).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('5 active members of staff'));
    expect(screen.queryByText('Aarav Iyer')).not.toBeInTheDocument();
  });

  it('cannot act on another hospital’s staff, or invite into another hospital’s role', async () => {
    // The admin belongs to the hospital only. The clinic's people do not exist for them.
    const path = { userId: USER_IDS.receptionist };
    await expect(
      api.POST('/staff/{userId}/deactivate', { params: { path } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      api.POST('/staff/{userId}/revoke-sessions', { params: { path } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // `receptionist` is a role of the clinic, not of the hospital.
    await expect(
      api.POST('/invites', {
        body: { name: 'N', email: 'n@sample-hospital.test', roleId: 'receptionist' },
        params: { header: { 'idempotency-key': 'test-key-0002' } },
      }),
    ).rejects.toMatchObject({ serverCode: 'unknown_role' });
  });
});
