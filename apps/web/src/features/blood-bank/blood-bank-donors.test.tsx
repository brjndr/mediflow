import { screen, waitFor, within } from '@testing-library/react';
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
import { clearMockPatientBloodGroup } from '@/mocks/handlers/blood-bank';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const donorGrid = () => screen.getByRole('table', { name: 'Donors' });
const rowOf = (number: string) =>
  within(donorGrid())
    .getAllByRole('row')
    .find((row) =>
      within(row).queryAllByRole('cell')[0]?.textContent?.includes(number),
    ) as HTMLElement;

const openDonors = async (number = 'DN-0001') => {
  renderApp({ entry: '/blood-bank' });
  await screen.findByRole('heading', { name: 'Blood bank', level: 1 });
  await userEvent.click(await screen.findByRole('tab', { name: 'Donors' }));
  await waitFor(() => expect(rowOf(number)).toBeDefined());
};

const press = (number: string, name: RegExp) =>
  userEvent.click(within(rowOf(number)).getByRole('button', { name }));

const refuse = (path: string, code: string, status: number) =>
  server.use(
    http.post(path, () =>
      HttpResponse.json({ error: { code, message: 'x', requestId: 'req_mock' } }, { status }),
    ),
  );

describe('the donor list', () => {
  it('shows donors with the name and phone masked, and no axe violations', async () => {
    await openDonors();
    const row = rowOf('DN-0001');
    expect(row).toHaveTextContent('R. T.');
    expect(row).not.toHaveTextContent('Rohan');
    expect(row).not.toHaveTextContent('9800000011');
    expect(row).toHaveTextContent('0011');
    await expectNoAxeViolations();
  });

  it('searches by the term in the body and filters by status', async () => {
    let body: unknown;
    server.use(
      http.post('*/api/blood/donors/search', async ({ request }) => {
        body = await request.clone().json();
        return undefined;
      }),
    );
    await openDonors();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search donors' }), 'Sara');
    await waitFor(() => expect(screen.queryByText(/DN-0001/)).not.toBeInTheDocument());
    expect(rowOf('DN-0002')).toBeDefined();
    expect(body).toMatchObject({ q: 'Sara' });
    expect(screen.queryByText('DN-0001')).not.toBeInTheDocument();
  });

  it('opens the full record on request, with the donor trace', async () => {
    await openDonors();
    await press('DN-0001', /Open record/);
    const dialog = await screen.findByRole('dialog', { name: 'Donor DN-0001' });
    expect(await within(dialog).findByText('Rohan Test-Donor')).toBeVisible();
    expect(await within(dialog).findByText(/Unit BU-0003/)).toBeVisible();
  });

  it('does not read the full record until someone asks', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/blood/donors/:donorId', () => {
        reads += 1;
        return undefined;
      }),
    );
    await openDonors();
    expect(reads).toBe(0);
  });

  it('leaves out the trace without transfusionReaction:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'transfusionReaction:read');
    await openDonors();
    await press('DN-0001', /Open record/);
    const dialog = await screen.findByRole('dialog', { name: 'Donor DN-0001' });
    await within(dialog).findByText('Rohan Test-Donor');
    expect(within(dialog).queryByText('Units made from this donor')).not.toBeInTheDocument();
  });
});

describe('registering a donor', () => {
  it('registers a donor and says so', async () => {
    await openDonors();
    await userEvent.click(screen.getByRole('button', { name: 'Register donor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register a donor' });
    await userEvent.type(within(dialog).getByLabelText(/Full name/), 'Meera Nair');
    await userEvent.type(within(dialog).getByLabelText(/Date of birth/), '1995-03-02');
    await userEvent.selectOptions(within(dialog).getByLabelText(/Blood group/), 'B+');
    await userEvent.type(within(dialog).getByLabelText(/Phone/), '+919811112222');
    await expectNoAxeViolations();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register donor' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
        'Donor DN-0004 registered',
      ),
    );
    await waitFor(() => expect(rowOf('DN-0004')).toHaveTextContent('M. N.'));
  });

  it('refuses a donor outside 18 to 65 before asking the server', async () => {
    await openDonors();
    await userEvent.click(screen.getByRole('button', { name: 'Register donor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register a donor' });
    await userEvent.type(within(dialog).getByLabelText(/Full name/), 'Young Person');
    await userEvent.type(within(dialog).getByLabelText(/Date of birth/), '2015-01-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register donor' }));
    expect(await within(dialog).findByText('A donor must be 18 to 65 years old.')).toBeVisible();
  });

  it('says so when the server refuses the age', async () => {
    refuse('*/api/blood/donors', 'donor_age', 422);
    await openDonors();
    await userEvent.click(screen.getByRole('button', { name: 'Register donor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register a donor' });
    await userEvent.type(within(dialog).getByLabelText(/Full name/), 'Meera Nair');
    await userEvent.type(within(dialog).getByLabelText(/Date of birth/), '1995-03-02');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register donor' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '18 to 65 years old on the day',
    );
  });
});

describe('recording a collection', () => {
  const fill = async (dialog: HTMLElement, unit: string) => {
    await userEvent.type(within(dialog).getByLabelText(/Unit number/), unit);
    await userEvent.type(within(dialog).getByLabelText(/Expires/), '2030-12-01T08:00');
  };

  it('makes a unit in collected status', async () => {
    await openDonors();
    await press('DN-0001', /Record collection/);
    const dialog = await screen.findByRole('dialog', {
      name: /Record a collection from donor DN-0001/,
    });
    await fill(dialog, 'BU-NEW1');
    await expectNoAxeViolations();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record collection' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
        'Unit BU-NEW1 is waiting for testing',
      ),
    );
  });

  it('records several units from one collection and refuses a repeated number', async () => {
    await openDonors();
    await press('DN-0001', /Record collection/);
    const dialog = await screen.findByRole('dialog', {
      name: /Record a collection from donor DN-0001/,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add another unit' }));
    const numbers = within(dialog).getAllByLabelText(/Unit number/);
    const expires = within(dialog).getAllByLabelText(/Expires/);
    expect(numbers).toHaveLength(2);
    await userEvent.type(numbers[0]!, 'BU-MULTI1');
    await userEvent.type(numbers[1]!, 'BU-MULTI1');
    await userEvent.type(expires[0]!, '2030-12-01T08:00');
    await userEvent.type(expires[1]!, '2030-12-01T08:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record collection' }));
    expect(await within(dialog).findByText(/same number/)).toBeInTheDocument();
    await userEvent.clear(numbers[1]!);
    await userEvent.type(numbers[1]!, 'BU-MULTI2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record collection' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
        '2 units (BU-MULTI1, BU-MULTI2) are waiting for testing',
      ),
    );
  });

  it('maps a donation that is too soon,a deferred donor and an age refusal', async () => {
    await openDonors('DN-0002');
    await press('DN-0002', /Record collection/);
    const dialog = await screen.findByRole('dialog', {
      name: /Record a collection from donor DN-0002/,
    });
    await fill(dialog, 'BU-NEW2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record collection' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('less than 90 days ago');

    refuse('*/api/blood/collections', 'donor_deferred', 422);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record collection' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'is deferred and cannot give blood',
      ),
    );

    refuse('*/api/blood/collections', 'donor_age', 422);
    await userEvent.clear(within(dialog).getByLabelText(/Unit number/));
    await userEvent.type(within(dialog).getByLabelText(/Unit number/), 'BU-NEW3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record collection' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('18 to 65 years old on the day'),
    );
  });

  it('does not offer a collection from a deferred donor', async () => {
    await openDonors('DN-0003');
    expect(
      within(rowOf('DN-0003')).getByRole('button', { name: /Record collection/ }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('deferring a donor', () => {
  it('defers until a date', async () => {
    await openDonors();
    await press('DN-0001', /Defer/);
    const dialog = await screen.findByRole('alertdialog', { name: 'Defer donor DN-0001' });
    await userEvent.type(within(dialog).getByLabelText(/^Until/), '2099-01-01');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Low haemoglobin');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Defer donor' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Donor DN-0001 deferred'),
    );
    await waitFor(() => expect(rowOf('DN-0001')).toHaveTextContent('Deferred until'));
  });

  it('warns that a permanent deferral is final', async () => {
    await openDonors();
    await press('DN-0001', /Defer/);
    const dialog = await screen.findByRole('alertdialog', { name: 'Defer donor DN-0001' });
    await userEvent.selectOptions(within(dialog).getByLabelText(/Deferral/), 'permanent');
    expect(within(dialog).getByText(/permanent deferral is final/i)).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Reactive screening');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Defer donor' }));
    await waitFor(() => expect(rowOf('DN-0001')).toHaveTextContent('Deferred for good'));
  });

  it('maps a date that is not in the future', async () => {
    refuse('*/api/blood/donors/:donorId/defer', 'invalid_period', 422);
    await openDonors();
    await press('DN-0001', /Defer/);
    const dialog = await screen.findByRole('alertdialog', { name: 'Defer donor DN-0001' });
    await userEvent.type(within(dialog).getByLabelText(/^Until/), '2099-01-01');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Low haemoglobin');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Defer donor' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('must be in the future');
  });
});

describe('editing a donor', () => {
  it('saves a corrected name and phone, leaving the group alone', async () => {
    await openDonors();
    await press('DN-0001', /^Edit/);
    const dialog = await screen.findByRole('dialog', { name: 'Edit donor DN-0001' });
    const name = await within(dialog).findByLabelText(/Full name/);
    expect(name).toHaveValue('Rohan Test-Donor');
    expect(within(dialog).queryByLabelText(/Blood group/)).not.toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, 'Rohan T Donor');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Donor DN-0001 saved'),
    );
    await press('DN-0001', /Open record/);
    const record = await screen.findByRole('dialog', { name: 'Donor DN-0001' });
    expect(await within(record).findByText('Rohan T Donor')).toBeVisible();
  });

  it('keeps what was typed when the save is refused as changed', async () => {
    let first = true;
    server.use(
      http.patch('*/api/blood/donors/:donorId', () => {
        if (!first) return undefined;
        first = false;
        return HttpResponse.json(
          { error: { code: 'conflict', message: 'x', requestId: 'req_mock' } },
          { status: 409 },
        );
      }),
    );
    await openDonors();
    await press('DN-0001', /^Edit/);
    const dialog = await screen.findByRole('dialog', { name: 'Edit donor DN-0001' });
    const name = await within(dialog).findByLabelText(/Full name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Rohan Typed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText(/Someone else saved this donor first/)).toBeVisible();
    expect(within(dialog).getByLabelText(/Full name/)).toHaveValue('Rohan Typed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit donor/ })).toBeNull());
  });

  it('has no Edit action without bloodDonor:manage', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodDonor:manage');
    await openDonors();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });
});

describe('access to donors', () => {
  it('has no Donors tab without bloodDonor:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodDonor:read');
    renderApp({ entry: '/blood-bank' });
    await screen.findByRole('heading', { name: 'Blood bank', level: 1 });
    expect(screen.queryByRole('tab', { name: 'Donors' })).not.toBeInTheDocument();
  });

  it('shows donors read-only without bloodDonor:manage', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodDonor:manage');
    await openDonors();
    expect(screen.queryByRole('button', { name: 'Register donor' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record collection/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Defer/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Open record/ }).length).toBeGreaterThan(0);
  });

  it('shows only the clinic donors at the clinic, never the hospital ones', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'bloodbank', true);
    grantPermission(TENANT_IDS.clinic, 'doctor', 'bloodUnit:read');
    grantPermission(TENANT_IDS.clinic, 'doctor', 'bloodDonor:read');
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/blood-bank' });
    await userEvent.click(await screen.findByRole('tab', { name: 'Donors' }));
    await waitFor(() => expect(rowOf('DN-0001')).toBeDefined());
    expect(rowOf('DN-0001')).toHaveTextContent('C. O.');
    expect(screen.queryByText(/R\. T\.-D\./)).not.toBeInTheDocument();
    expect(within(donorGrid()).getAllByRole('row')).toHaveLength(2);
  });
});

describe('the blood group tab of a patient', () => {
  const openPatient = async () => {
    renderApp({ entry: '/patients/pth_00001?tab=blood-group' });
    return screen.findByRole('heading', { name: 'Blood group', level: 2 });
  };

  it('shows the group on record and its history', async () => {
    await openPatient();
    expect(await screen.findByText('Blood group on record: O+')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Earlier entries' })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('needs a reason to change the group, and keeps the history', async () => {
    await openPatient();
    await screen.findByText('Blood group on record: O+');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Blood group/ }), 'A+');
    await userEvent.click(screen.getByRole('button', { name: 'Record blood group' }));
    expect(await screen.findByText('This field is required.')).toBeVisible();

    await userEvent.type(screen.getByLabelText(/Reason/), 'Re-typed in the laboratory');
    await userEvent.click(screen.getByRole('button', { name: 'Record blood group' }));
    expect(await screen.findByText('Blood group on record: A+')).toBeVisible();
    expect(screen.getByText(/Re-typed in the laboratory/)).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Earlier entries' })).getAllByRole('listitem'),
    ).toHaveLength(2);
  });

  it('maps the server refusing a change without a reason', async () => {
    await openPatient();
    await screen.findByText('Blood group on record: O+');
    refuse('*/api/patients/:patientId/blood-group', 'reason_required', 422);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Blood group/ }), 'B-');
    await userEvent.type(screen.getByLabelText(/Reason/), 'Re-typed');
    await userEvent.click(screen.getByRole('button', { name: 'Record blood group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A reason is needed');
  });

  it('writes nothing when the same group is recorded again', async () => {
    await openPatient();
    await screen.findByText('Blood group on record: O+');
    await userEvent.click(screen.getByRole('button', { name: 'Record blood group' }));
    await waitFor(() =>
      expect(screen.getByText(/already on record. Nothing changed/)).toBeVisible(),
    );
    expect(
      within(screen.getByRole('list', { name: 'Earlier entries' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('takes a first group when none is on record', async () => {
    clearMockPatientBloodGroup('pth_00001');
    await openPatient();
    expect(await screen.findByText('No blood group on record yet.')).toBeVisible();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Blood group/ }), 'AB-');
    await userEvent.click(screen.getByRole('button', { name: 'Record blood group' }));
    expect(await screen.findByText('Blood group on record: AB-')).toBeVisible();
  });

  it('has no form without patient.bloodGroup:update', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient.bloodGroup:update');
    await openPatient();
    await screen.findByText('Blood group on record: O+');
    expect(screen.queryByRole('button', { name: 'Record blood group' })).not.toBeInTheDocument();
  });

  it('has no tab without patient.bloodGroup:read or with the module off', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient.bloodGroup:read');
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tablist');
    expect(screen.queryByRole('tab', { name: 'Blood group' })).not.toBeInTheDocument();
  });

  it('has no tab when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'bloodbank', false);
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tablist');
    expect(screen.queryByRole('tab', { name: 'Blood group' })).not.toBeInTheDocument();
  });
});
