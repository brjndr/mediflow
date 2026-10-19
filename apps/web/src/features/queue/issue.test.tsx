import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Issue a token', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const openForm = async (entry = '/queue/new') => {
  const app = renderApp({ entry });
  await screen.findByRole('heading', HEADING);
  return app;
};

async function choosePatient(mrn = 'MRN-PTH-00001') {
  await userEvent.type(screen.getByRole('combobox', { name: 'Patient' }), mrn);
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(mrn) }));
  expect(await screen.findByRole('button', { name: 'Choose another patient' })).toBeInTheDocument();
}

async function chooseDepartment(name: string) {
  const department = screen.getByRole('combobox', { name: /^Department/ });
  await waitFor(() => expect(within(department).getAllByRole('option').length).toBeGreaterThan(1));
  await userEvent.selectOptions(department, name);
}

/** Every request to issue a token, with its idempotency key. */
function watchIssues(): { key: string | null; body: unknown }[] {
  const seen: { key: string | null; body: unknown }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/api/queue/tokens')) {
      void request
        .clone()
        .json()
        .then((body: unknown) => seen.push({ key: request.headers.get('Idempotency-Key'), body }));
    }
  });
  return seen;
}

describe('issuing a token', () => {
  it('issues the department’s next number to a walk-in, and confirms it in place', async () => {
    const issues = watchIssues();
    await openForm();
    await choosePatient();
    await chooseDepartment('dep_h_02');
    await userEvent.click(screen.getByRole('button', { name: 'Issue token' }));

    // Two tokens in that department already today.
    const done = await screen.findByRole('heading', { name: 'Token 3 issued' });
    expect(document.activeElement).toBe(done);
    expect(screen.getByRole('status')).toHaveTextContent(/^Token 3 for .+, .+, Any doctor\.$/);
    await waitFor(() => expect(issues).toHaveLength(1));
    expect(issues[0]?.body).toEqual({ patientId: 'pth_00001', departmentId: 'dep_h_02' });
    expect(issues[0]?.key).toMatch(/^[\w-]{8,}$/);
    await expectNoAxeViolations();

    // The next walk-in, at the same department.
    await userEvent.click(screen.getByRole('button', { name: 'Issue another' }));
    expect(await screen.findByRole('combobox', { name: 'Patient' })).toHaveFocus();
    expect(screen.getByRole('combobox', { name: /^Department/ })).toHaveValue('dep_h_02');
  });

  it('offers only the doctors of the chosen department, and a priority', async () => {
    const issues = watchIssues();
    await openForm();
    // No doctor until a department is chosen.
    expect(screen.queryByRole('combobox', { name: /^Doctor/ })).not.toBeInTheDocument();
    await choosePatient();
    await chooseDepartment('dep_h_01');
    const doctor = screen.getByRole('combobox', { name: /^Doctor/ });
    const offered = within(doctor)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(offered).toEqual(['', 'doc_h_01']);
    await userEvent.selectOptions(doctor, 'doc_h_01');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Priority/ }), 'Child');
    await userEvent.click(screen.getByRole('button', { name: 'Issue token' }));

    await screen.findByRole('heading', { name: 'Token 6 issued' });
    await waitFor(() => expect(issues).toHaveLength(1));
    expect(issues[0]?.body).toEqual({
      patientId: 'pth_00001',
      departmentId: 'dep_h_01',
      doctorId: 'doc_h_01',
      priority: 'child',
    });
  });

  it('lets a doctor of another department go when the department changes', async () => {
    await openForm();
    await chooseDepartment('dep_h_01');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Doctor/ }), 'doc_h_01');
    await chooseDepartment('dep_h_02');
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Doctor/ })).toHaveValue(''));
  });

  it('asks for the patient and the department, focusing the first', async () => {
    await openForm();
    await userEvent.click(screen.getByRole('button', { name: 'Issue token' }));
    expect(await screen.findByText('Choose the patient.')).toBeInTheDocument();
    expect(screen.getByText('Choose a department.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Patient' })).toHaveFocus();
  });

  it('says so when the patient already has a token in that department today', async () => {
    await openForm();
    // The second token of the first department is this patient's.
    await choosePatient('MRN-PTH-00102');
    await chooseDepartment('dep_h_01');
    await userEvent.click(screen.getByRole('button', { name: 'Issue token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This patient already has a token in this department today.',
    );
  });

  it('starts on the patient whose screen it was opened from', async () => {
    renderApp({ entry: '/patients/pth_00001' });
    await userEvent.click(await screen.findByRole('link', { name: 'Issue a queue token' }));
    await screen.findByRole('heading', HEADING);
    expect(
      await screen.findByRole('button', { name: 'Choose another patient' }),
    ).toBeInTheDocument();
    expect(screen.getByText('MRN MRN-PTH-00001')).toBeInTheDocument();
    await chooseDepartment('dep_h_02');
    await userEvent.click(screen.getByRole('button', { name: 'Issue token' }));
    expect(await screen.findByRole('heading', { name: 'Token 3 issued' })).toBeInTheDocument();
  });

  it('ignores a malformed patient id in the address', async () => {
    await openForm('/queue/new?patientId=%3Cscript%3E');
    expect(screen.getByRole('combobox', { name: 'Patient' })).toBeInTheDocument();
  });
});

describe('access', () => {
  it('is not open without queue:create, and the patient screen does not offer it', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/queue/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('has no "Issue a queue token" on the patient screen without queue:create', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'queue:create');
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('link', { name: 'Edit' });
    expect(screen.queryByRole('link', { name: 'Issue a queue token' })).not.toBeInTheDocument();
  });

  it('says what is missing without finding patients', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'patients', false);
    await openForm();
    expect(screen.getByRole('alert')).toHaveTextContent('Issuing a token needs finding a patient');
  });

  it('says what is missing without departments', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'department:read');
    await openForm();
    expect(screen.getByRole('alert')).toHaveTextContent('Issuing a token needs departments');
  });

  it('is refused by the server without reading patients, saying no more than "unknown"', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:read');
    const result = await api
      .POST('/queue/tokens', {
        body: { patientId: 'pth_00001', departmentId: 'dep_h_02' },
        params: { header: { 'idempotency-key': 'key-no-patient-read' } },
      })
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 422, serverCode: 'unknown_patient' });
  });

  it('is unreachable with the queue switched off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'queue', false);
    renderApp({ entry: '/queue/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});
