import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { editMockAvailability, editMockDoctor } from '@/mocks/handlers/doctors';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { doctorKeys } from './hooks/use-doctors';
import { hoursProblems } from './schemas';

const HEADING = { name: 'Doctors', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const openList = async () => {
  const app = renderApp({ entry: '/doctors' });
  await screen.findByRole('link', { name: 'Aarav Iyer' });
  return app;
};
/** Diya Sharma, a cardiologist at the hospital. */
const openDoctor = async (id = 'doc_h_02') => {
  const app = renderApp({ entry: `/doctors/${id}` });
  await screen.findByRole('heading', { name: 'Working hours' });
  await screen.findByLabelText('Monday, session 1: from');
  return app;
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statuses = () => screen.getAllByRole('status').map((status) => status.textContent);
const textbox = (name: RegExp) => screen.getByRole('textbox', { name });
const setTime = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function type(name: RegExp, text: string) {
  await userEvent.clear(textbox(name));
  if (text) await userEvent.type(textbox(name), text);
}

async function chooseDepartment(name: string) {
  await screen.findByRole('option', { name });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Department/ }), name);
}

describe('the doctor list', () => {
  it('lists the hospital’s doctors by name, a page at a time', async () => {
    await openList();

    expect(screen.getByRole('heading', HEADING)).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('28 doctors'));
    expect(screen.queryByRole('link', { name: 'Zoya Sharma' })).not.toBeInTheDocument();
    // Someone who no longer practises here is not in the list.
    expect(screen.queryByRole('link', { name: 'Rohan Nair' })).not.toBeInTheDocument();

    await userEvent.click(button('Load more'));
    expect(await screen.findByRole('link', { name: 'Zoya Sharma' })).toBeInTheDocument();
  });

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Doctors' }));

    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('narrows to a department', async () => {
    await openList();
    await screen.findByRole('option', { name: 'Cardiology' });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Department' }),
      'Cardiology',
    );

    await waitFor(() => expect(statuses()).toContain('1 doctor'));
    expect(screen.getByRole('link', { name: 'Diya Sharma' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Aarav Iyer' })).not.toBeInTheDocument();
  });

  it('searches by name or specialization on the server', async () => {
    await openList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search doctors' }), 'surgery');
    await waitFor(() => expect(statuses()).toContain('6 doctors'));

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search doctors' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search doctors' }), 'nobody');
    expect(await screen.findByText('No doctor matches these filters.')).toBeInTheDocument();
  });

  it('shows the inactive doctors only when asked', async () => {
    await openList();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show inactive doctors' }));

    expect(await screen.findByRole('link', { name: 'Rohan Nair' })).toBeInTheDocument();
    expect(statuses()).toContain('1 inactive doctor');
    expect(screen.queryByRole('link', { name: 'Aarav Iyer' })).not.toBeInTheDocument();
  });
});

describe('adding a doctor', () => {
  const openCreate = async () => {
    const app = renderApp({ entry: '/doctors/new' });
    await screen.findByRole('heading', { name: 'Add a doctor' });
    await screen.findByRole('radio', { name: /Sample Doctor/ });
    return app;
  };

  it('offers only staff who have no profile yet, and finds one by name', async () => {
    await openCreate();

    // Diya Sharma is a doctor here already.
    expect(screen.queryByRole('radio', { name: /Diya Sharma/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a staff member' }), 'patel');
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    expect(screen.getByRole('radio', { name: /Meera Patel/ })).toBeInTheDocument();
  });

  it('creates the profile and opens it, with no working hours yet', async () => {
    const { router } = await openCreate();
    await userEvent.click(screen.getByRole('radio', { name: /Sample Doctor/ }));
    await chooseDepartment('Cardiology');
    await type(/^Specialization/, 'Electrophysiology');
    await type(/^Registration number/, 'MCI-12345');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /^Appointment length/ }),
      '20 min',
    );
    await userEvent.click(button('Add doctor'));

    expect(await screen.findByRole('heading', { name: 'Sample Doctor' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/doctors/doc_new_1');
    expect(screen.getByText('Electrophysiology')).toBeInTheDocument();
    expect(screen.getByText('MCI-12345')).toBeInTheDocument();
    expect(screen.getByText('20 min')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Day off')).toHaveLength(7));
  });

  it('needs a staff member, a department and a specialization, and sends nothing without', async () => {
    let sent = 0;
    server.use(
      http.post('*/api/doctors', () => {
        sent++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await openCreate();
    await userEvent.click(button('Add doctor'));
    // Everything that is missing is said at once.
    expect(await screen.findAllByText('This field is required.')).toHaveLength(2);
    expect(screen.getByText('Choose a staff member.')).toBeInTheDocument();

    await chooseDepartment('Cardiology');
    await type(/^Specialization/, 'Electrophysiology');
    await userEvent.click(button('Add doctor'));

    expect(await screen.findByText('Choose a staff member.')).toBeInTheDocument();
    expect(sent).toBe(0);
  });

  it('does not save the form when Enter is pressed in the staff search', async () => {
    let sent = 0;
    server.use(
      http.post('*/api/doctors', () => {
        sent++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await openCreate();
    await userEvent.click(screen.getByRole('radio', { name: /Sample Doctor/ }));
    await chooseDepartment('Cardiology');
    await type(/^Specialization/, 'Electrophysiology');
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find a staff member' }),
      'sam{Enter}',
    );

    await screen.findByRole('radio', { name: /Sample Admin/ });
    expect(sent).toBe(0);
  });

  it('says so when that person was given a profile meanwhile', async () => {
    await openCreate();
    await userEvent.click(screen.getByRole('radio', { name: /Sample Doctor/ }));
    await chooseDepartment('Cardiology');
    await type(/^Specialization/, 'Electrophysiology');
    // Someone else adds the same person first.
    await api.POST('/doctors', {
      body: {
        userId: USER_IDS.doctor,
        departmentId: 'dep_h_02',
        specialization: 'Cardiology',
        consultationMinutes: 15,
      },
    });
    await userEvent.click(button('Add doctor'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This staff member already has a doctor profile.',
    );
    expect(textbox(/^Specialization/)).toHaveValue('Electrophysiology');
    // They are no longer someone to choose.
    await waitFor(() =>
      expect(screen.queryByRole('radio', { name: /Sample Doctor/ })).not.toBeInTheDocument(),
    );
  });
});

describe('a doctor’s profile', () => {
  it('shows the profile and the working hours', async () => {
    await openDoctor();

    expect(screen.getByRole('heading', { name: 'Diya Sharma' })).toBeInTheDocument();
    expect(screen.getAllByText('Cardiology').length).toBeGreaterThan(0);
    expect(screen.getByText('Surgery')).toBeInTheDocument();
    expect(screen.getByText('Not given')).toBeInTheDocument();
    expect(screen.getByLabelText('Monday, session 1: from')).toHaveValue('09:00');
    expect(screen.getByLabelText('Friday, session 1: to')).toHaveValue('13:00');
    expect(screen.getAllByText('Day off')).toHaveLength(2);
  });

  it('saves a change to the profile', async () => {
    await openDoctor();
    await userEvent.click(button('Edit profile'));
    expect(textbox(/^Specialization/)).toHaveValue('Surgery');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^Department/ })).toHaveValue('dep_h_02'),
    );

    await type(/^Specialization/, 'Cardiac surgery');
    await chooseDepartment('Neurology');
    await userEvent.click(button('Save profile'));

    await waitFor(() => expect(statuses()).toContain('The profile was saved.'));
    expect(await screen.findByText('Cardiac surgery')).toBeInTheDocument();
    expect(screen.getAllByText('Neurology').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Save profile' })).not.toBeInTheDocument();
  });

  it('keeps what was typed after a conflict, and saves it without undoing the other change', async () => {
    await openDoctor();
    await userEvent.click(button('Edit profile'));
    // Someone else records the registration number meanwhile.
    editMockDoctor('doc_h_02', { registrationNumber: 'REG-9' });

    await type(/^Specialization/, 'Cardiac surgery');
    await userEvent.click(button('Save profile'));

    expect(await screen.findByText(/Someone else changed this profile/)).toBeInTheDocument();
    // The form is still open with what was typed.
    expect(textbox(/^Specialization/)).toHaveValue('Cardiac surgery');

    await waitFor(() => expect(button('Save profile')).toBeEnabled());
    await userEvent.click(button('Save profile'));

    await waitFor(() => expect(statuses()).toContain('The profile was saved.'));
    expect(await screen.findByText('Cardiac surgery')).toBeInTheDocument();
    // Only the changed field was sent: their registration number is still there.
    expect(screen.getByText('REG-9')).toBeInTheDocument();
  });

  it('sends only what was changed, and keeps an appointment length that is not on the list', async () => {
    editMockDoctor('doc_h_02', { consultationMinutes: 25 });
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH')
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body));
    });
    await openDoctor();
    await userEvent.click(button('Edit profile'));
    expect(screen.getByRole('combobox', { name: /^Appointment length/ })).toHaveValue('25');

    await type(/^Specialization/, 'Cardiac surgery');
    await userEvent.click(button('Save profile'));

    await waitFor(() => expect(statuses()).toContain('The profile was saved.'));
    expect(bodies).toEqual([{ specialization: 'Cardiac surgery', expectedVersion: 2 }]);
    expect(screen.getByText('25 min')).toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it('sends nothing when nothing was changed', async () => {
    let sent = 0;
    server.use(
      http.patch('*/api/doctors/:id', () => {
        sent++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await openDoctor();
    await userEvent.click(button('Edit profile'));
    await userEvent.click(button('Save profile'));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save profile' })).not.toBeInTheDocument(),
    );
    expect(sent).toBe(0);
  });

  it('marks a doctor inactive and active again', async () => {
    await openDoctor();
    await userEvent.click(button('Mark as inactive'));

    await waitFor(() => expect(statuses()).toContain('Diya Sharma is now inactive.'));
    expect(await screen.findByText('Inactive')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Make active again' }));
    await waitFor(() => expect(statuses()).toContain('Diya Sharma is active again.'));
    await waitFor(() => expect(screen.queryByText('Inactive')).not.toBeInTheDocument());
  });

  it('has one answer for a doctor that does not exist and one of another hospital', async () => {
    renderApp({ entry: '/doctors/doc_c_01' });

    expect(await screen.findByRole('heading', { name: 'Doctor not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the doctor list' })).toBeInTheDocument();
  });
});

describe('working hours', () => {
  it('saves a second session and a new day', async () => {
    await openDoctor();
    await userEvent.click(button('Add hours on Monday'));
    setTime('Monday, session 2: from', '17:00');
    setTime('Monday, session 2: to', '20:00');
    await userEvent.click(button('Add hours on Saturday'));
    setTime('Saturday, session 1: from', '10:00');
    setTime('Saturday, session 1: to', '12:30');
    await userEvent.click(button('Remove Friday session 1'));
    await userEvent.click(button('Save working hours'));

    await waitFor(() => expect(statuses()).toContain('The working hours were saved.'));
    const saved = await api.GET('/doctors/{doctorId}/availability', {
      params: { path: { doctorId: 'doc_h_02' } },
    });
    expect(saved.data?.version).toBe(2);
    expect(saved.data?.sessions).toContainEqual({ day: 'mon', start: '17:00', end: '20:00' });
    expect(saved.data?.sessions).toContainEqual({ day: 'sat', start: '10:00', end: '12:30' });
    expect(saved.data?.sessions.some((session) => session.day === 'fri')).toBe(false);
    // The editor shows what was saved.
    expect(await screen.findByLabelText('Saturday, session 1: from')).toHaveValue('10:00');
  });

  it('refuses hours that overlap, end before they start or are half filled in', async () => {
    let sent = 0;
    server.use(
      http.put('*/api/doctors/:id/availability', () => {
        sent++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await openDoctor();
    await userEvent.click(button('Add hours on Monday'));
    setTime('Monday, session 2: from', '12:00');
    setTime('Monday, session 2: to', '14:00');
    setTime('Tuesday, session 1: to', '08:00');
    await userEvent.click(button('Add hours on Sunday'));
    await userEvent.click(button('Save working hours'));

    expect(await screen.findByText('Two sessions on this day overlap.')).toBeInTheDocument();
    expect(screen.getByText('A session must end after it starts.')).toBeInTheDocument();
    expect(screen.getByText('Give both a start and an end time.')).toBeInTheDocument();
    expect(sent).toBe(0);

    // The messages follow the correction.
    setTime('Monday, session 2: from', '13:00');
    expect(screen.queryByText('Two sessions on this day overlap.')).not.toBeInTheDocument();
  });

  it('checks each day on its own', () => {
    expect(
      hoursProblems([
        { day: 'mon', start: '09:00', end: '13:00' },
        { day: 'mon', start: '13:00', end: '17:00' },
        { day: 'tue', start: '09:00', end: '13:00' },
      ]),
    ).toEqual({});
    expect(
      hoursProblems([
        { day: 'wed', start: '14:00', end: '18:00' },
        { day: 'wed', start: '09:00', end: '15:00' },
      ]),
    ).toEqual({ wed: 'hours.errors.overlap' });
  });

  it('keeps the hours that were typed after a conflict, and replaces theirs only on a second save', async () => {
    await openDoctor();
    editMockAvailability('doc_h_02', [{ day: 'sun', start: '08:00', end: '11:00' }]);
    setTime('Monday, session 1: from', '10:00');
    await userEvent.click(button('Save working hours'));

    expect(await screen.findByText(/Someone else changed these hours/)).toBeInTheDocument();
    // What was typed is still in the editor.
    expect(screen.getByLabelText('Monday, session 1: from')).toHaveValue('10:00');

    await waitFor(() => expect(button('Save working hours')).toBeEnabled());
    await userEvent.click(button('Save working hours'));

    await waitFor(() => expect(statuses()).toContain('The working hours were saved.'));
    expect(screen.queryByText(/Someone else changed these hours/)).not.toBeInTheDocument();
    const saved = await api.GET('/doctors/{doctorId}/availability', {
      params: { path: { doctorId: 'doc_h_02' } },
    });
    expect(saved.data?.sessions).toContainEqual({ day: 'mon', start: '10:00', end: '13:00' });
    expect(saved.data?.sessions.some((session) => session.day === 'sun')).toBe(false);
  });

  it('lets nothing be typed into a save that is on its way', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.put(
        '*/api/doctors/:id/availability',
        async () => {
          await held;
          return undefined;
        },
        { once: true },
      ),
    );
    await openDoctor();
    setTime('Monday, session 1: from', '10:00');
    await userEvent.click(button('Save working hours'));

    await waitFor(() => expect(screen.getByLabelText('Monday, session 1: from')).toBeDisabled());
    expect(button('Add hours on Monday')).toBeDisabled();

    release();
    await waitFor(() => expect(statuses()).toContain('The working hours were saved.'));
    expect(await screen.findByLabelText('Monday, session 1: from')).toHaveValue('10:00');
    expect(screen.getByLabelText('Monday, session 1: from')).toBeEnabled();
  });

  it('is not taken away by a refresh while someone is typing', async () => {
    const { queryClient } = await openDoctor();
    setTime('Monday, session 1: from', '10:00');
    // Someone else saves other hours, and this screen's data is refreshed in the background.
    editMockAvailability('doc_h_02', [{ day: 'sun', start: '08:00', end: '11:00' }]);
    await queryClient.invalidateQueries({ queryKey: doctorKeys.all(TENANT_IDS.hospital) });

    expect(screen.getByLabelText('Monday, session 1: from')).toHaveValue('10:00');
    expect(screen.queryByLabelText('Sunday, session 1: from')).not.toBeInTheDocument();
  });
});

describe('access', () => {
  it('lets someone who may only read see doctors and hours, with nothing to change them', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openList();
    expect(screen.queryByRole('link', { name: 'Add a doctor' })).not.toBeInTheDocument();

    renderApp({ entry: '/doctors/doc_h_02' });
    const hours = await screen.findByRole('region', { name: 'Working hours' });
    expect(await within(hours).findAllByText('09:00 – 13:00')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /Edit profile|Mark as inactive/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save working hours|Add hours/ })).toBeNull();
  });

  it('keeps the add screen from someone who may only read', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/doctors/new' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is refused by the server too, whatever the screen offers', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const path = { doctorId: 'doc_h_02' };

    await expect(api.GET('/doctors/candidates', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      api.PATCH('/doctors/{doctorId}', {
        params: { path },
        body: { active: false, expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.PUT('/doctors/{doctorId}/availability', {
        params: { path },
        body: { sessions: [], expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('has no screen and no navigation entry without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'doctor', 'doctor:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/doctors' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Doctors' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'doctors', false);
    renderApp({ entry: '/doctors' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Doctors' })).not.toBeInTheDocument();
    await expect(api.GET('/doctors', { params: { query: {} } })).rejects.toMatchObject({
      code: 'forbidden',
      serverCode: 'feature_disabled',
    });
  });
});

describe('two hospitals', () => {
  it('never shows one hospital’s doctors in the other', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { queryClient, router } = await openList();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: doctorKeys.all(TENANT_IDS.hospital) }),
    ).not.toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    // Nothing cached for the previous hospital survives the switch.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: doctorKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);

    await router.navigate('/doctors');
    expect(await screen.findByRole('link', { name: 'Sample Doctor' })).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toContain('2 doctors'));
    expect(screen.queryByRole('link', { name: 'Aarav Iyer' })).not.toBeInTheDocument();
  });

  it('cannot read or change another hospital’s doctor', async () => {
    // The admin belongs to the hospital only. A clinic doctor does not exist for them.
    const path = { doctorId: 'doc_c_01' };
    await expect(api.GET('/doctors/{doctorId}', { params: { path } })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      api.GET('/doctors/{doctorId}/availability', { params: { path } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      api.PUT('/doctors/{doctorId}/availability', {
        params: { path },
        body: { sessions: [], expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot give a profile to another hospital’s staff, or in another hospital’s department', async () => {
    const body = { specialization: 'General practice', consultationMinutes: 15 };
    // The receptionist works at the clinic only.
    await expect(
      api.POST('/doctors', {
        body: { ...body, userId: USER_IDS.receptionist, departmentId: 'dep_h_02' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      api.POST('/doctors', {
        body: { ...body, userId: USER_IDS.doctor, departmentId: 'dep_c_01' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});
