import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { renderApp } from '@/test/render';
import { createPatient } from './api';
import { patientKeys } from './hooks/use-patients';

const NO_ACCESS = { name: 'You do not have access to this page' };
const HEADING = { name: 'Register a patient' };
const registerLink = () => screen.queryByRole('link', { name: 'Register a patient' });

interface Seen {
  creates: { key: string | null; body: Record<string, unknown>; search: string }[];
  checks: { search: string; body: Record<string, unknown> }[];
}

/** Records registration requests, then lets the mock backend answer. */
function watchRegistration(): Seen {
  const seen: Seen = { creates: [], checks: [] };
  server.use(
    http.post('*/api/patients', async ({ request }) => {
      seen.creates.push({
        key: request.headers.get('Idempotency-Key'),
        body: (await request.clone().json()) as Record<string, unknown>,
        search: new URL(request.url).search,
      });
      return undefined;
    }),
    http.post('*/api/patients/duplicate-check', async ({ request }) => {
      seen.checks.push({
        search: new URL(request.url).search,
        body: (await request.clone().json()) as Record<string, unknown>,
      });
      return undefined;
    }),
  );
  return seen;
}

async function fill(
  overrides: Partial<Record<'firstName' | 'lastName' | 'dob' | 'phone', string>> = {},
) {
  const values = {
    firstName: 'Mira',
    lastName: 'Kapoor',
    dob: '1990-05-17',
    phone: '+91 91234 56789',
    ...overrides,
  };
  await userEvent.type(screen.getByLabelText(/First name/), values.firstName);
  await userEvent.type(screen.getByLabelText(/Last name/), values.lastName);
  await userEvent.type(screen.getByLabelText(/Date of birth/), values.dob);
  await userEvent.selectOptions(screen.getByLabelText(/Gender/), 'female');
  await userEvent.type(screen.getByLabelText(/Phone number/), values.phone);
}

const submit = () => userEvent.click(screen.getByRole('button', { name: 'Register patient' }));

describe('patient registration', () => {
  it('registers a patient and shows the new MRN', async () => {
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();

    await fill();
    await userEvent.type(screen.getByLabelText(/Email/), 'mira@example.test');
    await userEvent.click(screen.getByLabelText(/agrees to be contacted/));
    await submit();

    expect(await screen.findByText('MRN-PTH-12001')).toBeInTheDocument();
    expect(seen.creates).toHaveLength(1);
    expect(seen.creates[0]?.body).toMatchObject({
      firstName: 'Mira',
      lastName: 'Kapoor',
      email: 'mira@example.test',
      contactConsent: { given: true },
    });
    // The client sends the decision only: the server records when and by whom.
    expect(seen.creates[0]?.body.contactConsent).toEqual({ given: true });
    // Patient details travel in bodies, never in a query string.
    expect(seen.creates[0]?.search).toBe('');
    expect(seen.checks).toHaveLength(1);
    expect(seen.checks[0]?.search).toBe('');
    expect(seen.checks[0]?.body).toMatchObject({ lastName: 'Kapoor', dob: '1990-05-17' });
  });

  it('shows validation errors and sends nothing', async () => {
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    await submit();

    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThan(0);
    expect(seen.checks).toHaveLength(0);
    expect(seen.creates).toHaveLength(0);
  });

  it('rejects a date of birth in the future', async () => {
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    await fill({ dob: '2999-01-01' });
    await submit();

    expect(await screen.findByText('This value is not in the expected format.')).toBeVisible();
    expect(seen.creates).toHaveLength(0);
  });

  it('warns about a possible duplicate, with masked details, before saving', async () => {
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    // The first sample patient: Asha Verma1, born 1950-01-01.
    await fill({
      firstName: 'Asha',
      lastName: 'Verma1',
      dob: '1950-01-01',
      phone: '+91 98000 10000',
    });
    await submit();

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('This patient may already be registered');
    expect(warning).toHaveTextContent('Asha Verma1');
    expect(warning.textContent).not.toContain('MRN-PTH-00001');
    expect(warning.textContent).not.toContain('98000 10000');
    expect(seen.creates).toHaveLength(0);

    // Going back keeps what was typed.
    await userEvent.click(screen.getByRole('button', { name: 'Back to the form' }));
    expect(await screen.findByLabelText(/First name/)).toHaveValue('Asha');

    await submit();
    await userEvent.click(await screen.findByRole('button', { name: 'Register anyway' }));
    expect(await screen.findByText('MRN-PTH-12001')).toBeInTheDocument();
    expect(seen.creates).toHaveLength(1);
  });

  it('returns possible duplicates masked by the server, with no id', async () => {
    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    const result = await api.POST('/patients/duplicate-check', {
      body: { firstName: 'Asha', lastName: 'Verma1', dob: '1950-01-01', phone: '+91 98000 10000' },
    });
    const text = JSON.stringify(result.data);
    expect(result.data?.items).toHaveLength(1);
    expect(text).not.toContain('98000 10000');
    expect(text).not.toContain('MRN-PTH-00001');
    expect(text).not.toContain('"id"');
  });

  it('creates one patient however many times the button is pressed', async () => {
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    await fill();
    const button = screen.getByRole('button', { name: 'Register patient' });
    await userEvent.dblClick(button);

    expect(await screen.findByText('MRN-PTH-12001')).toBeInTheDocument();
    expect(seen.creates).toHaveLength(1);
    expect(seen.creates[0]?.key).toMatch(/\S{8,}/);
  });

  it('does not register when the duplicate check fails', async () => {
    const seen = watchRegistration();
    server.use(
      http.post('*/api/patients/duplicate-check', () =>
        Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    await fill();
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side');
    expect(seen.creates).toHaveLength(0);
  });

  it('reads the record afresh when the server answers a repeat with the id only', async () => {
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);
    const details = {
      firstName: 'Meera',
      lastName: 'Nair',
      dob: '1988-03-14',
      gender: 'female',
      phone: '98000 55555',
    } as const;

    const first = await createPatient(details, 'key-repeat-0001');
    const again = await createPatient(details, 'key-repeat-0001');

    expect(first.mrn).toMatch(/^MRN-/);
    expect(again).toEqual(first);
  });

  it('uses a new idempotency key when the details are edited', async () => {
    server.use(
      http.post('*/api/patients', () =>
        Response.json({ error: { code: 'internal', message: 'x' } }, { status: 500 }),
      ),
    );
    // Registered after the failing handler, so it sees each request first.
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);
    await fill();
    await submit();
    await screen.findByRole('alert');

    await userEvent.type(screen.getByLabelText(/Last name/), 'x');
    await submit();
    await waitFor(() => expect(seen.creates).toHaveLength(2));
    expect(seen.creates[0]?.key).not.toBe(seen.creates[1]?.key);
  });

  it('shows a friendly error, never the server message', async () => {
    server.use(
      http.post('*/api/patients', () =>
        Response.json(
          { error: { code: 'internal', message: 'duplicate key value violates mrn_idx' } },
          { status: 500 },
        ),
      ),
    );
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    await fill();
    await submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side');
    expect(alert).not.toHaveTextContent('mrn_idx');
  });
});

describe('permission absent', () => {
  it('blocks the page and hides the entry point without patient:create', async () => {
    const seen = watchRegistration();
    signIn(USER_IDS.billingClerk, TENANT_IDS.clinic);
    renderApp({ entry: '/patients' });
    await screen.findByRole('heading', { name: 'Patients' });
    expect(registerLink()).not.toBeInTheDocument();

    renderApp({ entry: '/patients/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(seen.checks).toHaveLength(0);
    expect(seen.creates).toHaveLength(0);
  });

  it('shows the entry point to a role that can create', async () => {
    renderApp({ entry: '/patients' });
    expect(await screen.findByRole('link', { name: 'Register a patient' })).toHaveAttribute(
      'href',
      '/patients/new',
    );
  });

  it('is enforced by the API too', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await expect(
      api.POST('/patients/duplicate-check', {
        body: { firstName: 'A', lastName: 'B', dob: '1990-01-01', phone: '12345' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden', serverCode: 'permission_denied' });
  });
});

describe('feature flag off', () => {
  it('makes the registration page unreachable', async () => {
    const seen = watchRegistration();
    setTenantFeature(TENANT_IDS.clinic, 'patients', false);
    signIn(USER_IDS.receptionist, TENANT_IDS.clinic);
    renderApp({ entry: '/patients/new' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(seen.creates).toHaveLength(0);
  });
});

describe('two hospitals', () => {
  it('registers in the active hospital only', async () => {
    signIn(USER_IDS.receptionist, TENANT_IDS.clinic);
    const { queryClient } = renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);
    // A list cached for the other hospital, and one for this hospital.
    const hospitalKey = patientKeys.list(TENANT_IDS.hospital, { q: '' });
    const clinicKey = patientKeys.list(TENANT_IDS.clinic, { q: '' });
    queryClient.setQueryData(hospitalKey, 'hospital list');
    queryClient.setQueryData(clinicKey, 'clinic list');
    await fill();
    await submit();
    // The clinic had 40 patients, so this is its 41st, with the clinic's own MRN series.
    expect(await screen.findByText('MRN-PTC-00041')).toBeInTheDocument();

    // Registering refreshes this hospital's lists and leaves the other hospital's alone.
    expect(queryClient.getQueryState(clinicKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(hospitalKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(hospitalKey)).toBe('hospital list');

    const page = await api.POST('/patients/search', { body: { q: 'Kapoor', limit: 25 } });
    expect(page.data?.total).toBe(1);

    cleanup();
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/patients' });
    expect(await screen.findByText('12000 patients')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search patients' }), 'Kapoor');
    expect(await screen.findByText('No patients match your search.')).toBeInTheDocument();
  });
});

describe('suggestions while registering', () => {
  const SUGGESTION = 'Someone like this is already registered';

  it('says that someone like this is already registered before anything is saved', async () => {
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    // The name and date of birth of the first patient in the register.
    await fill({ firstName: 'Asha', lastName: 'Verma1', dob: '1950-01-01' });

    expect(await screen.findByText(SUGGESTION, undefined, { timeout: 4000 })).toBeInTheDocument();
    // Masked, like the warning on saving: enough to recognise the person.
    const text = document.body.textContent ?? '';
    expect(text).toContain('Asha Verma1');
    expect(text).not.toContain('MRN-PTH-00001');
    expect(text).not.toContain('98000 10000');
    // Nothing has been saved, and the details went in the body of the check.
    expect(seen.creates).toEqual([]);
    expect(seen.checks.at(-1)).toMatchObject({
      search: '',
      body: { firstName: 'Asha', lastName: 'Verma1', dob: '1950-01-01' },
    });
  });

  it('makes no check until the details are complete, and shows nothing when nobody matches', async () => {
    const seen = watchRegistration();
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);

    await userEvent.type(screen.getByLabelText(/First name/), 'Mira');
    await userEvent.type(screen.getByLabelText(/Last name/), 'Kapoor');
    await userEvent.type(screen.getByLabelText(/Date of birth/), '1990-05-17');
    await new Promise((resolve) => setTimeout(resolve, 900));
    // No phone number yet: nothing to check.
    expect(seen.checks).toEqual([]);

    await userEvent.type(screen.getByLabelText(/Phone number/), '+91 91234 56789');
    await waitFor(() => expect(seen.checks).toHaveLength(1), { timeout: 4000 });
    expect(screen.queryByText(SUGGESTION)).not.toBeInTheDocument();
  });

  it('still registers when the check made while typing fails', async () => {
    let failing = true;
    server.use(
      http.post('*/api/patients/duplicate-check', () =>
        failing
          ? Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
          : undefined,
      ),
    );
    renderApp({ entry: '/patients/new' });
    await screen.findByRole('heading', HEADING);
    await fill();
    await new Promise((resolve) => setTimeout(resolve, 900));

    // A failed suggestion is not shown as an error: saving makes its own check.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    failing = false;
    await submit();

    expect(await screen.findByText(/^MRN-PTH-/)).toBeInTheDocument();
  });
});
