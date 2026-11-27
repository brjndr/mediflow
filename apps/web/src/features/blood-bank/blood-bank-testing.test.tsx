import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { addMockBloodUnit } from '@/mocks/handlers/blood-bank';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Blood bank', level: 1 };

const grid = () => screen.getByRole('table', { name: 'Blood units' });
const rowOf = (unit: string) =>
  within(grid())
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === unit) as HTMLElement;
const statusLine = () => screen.getByRole('status', { name: '' });

const open = async (unit = 'BU-0001', status?: string) => {
  renderApp({ entry: '/blood-bank' });
  await screen.findByRole('heading', HEADING);
  if (status) {
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), status);
  }
  await waitFor(() => expect(rowOf(unit)).toBeDefined());
};

/** Finds the first sample patient (Asha Verma1, blood group O+ in the mock) and picks her. */
const pickPatient = async (scope: HTMLElement) => {
  await userEvent.type(within(scope).getByRole('combobox', { name: /Patient/ }), 'Asha Verma1');
  await userEvent.click(await within(scope).findByRole('option', { name: /Asha Verma1(?![0-9])/ }));
};

const press = (unit: string, name: RegExp) =>
  userEvent.click(within(rowOf(unit)).getByRole('button', { name }));

describe('screening a unit', () => {
  it('warns that a reactive result discards the unit, and does it', async () => {
    await open('BU-0002', 'In testing');
    await press('BU-0002', /Record screening/);
    const dialog = await screen.findByRole('dialog', { name: 'Screening of unit BU-0002' });
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(5);
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /Hepatitis B/ }),
      'Reactive',
    );
    expect(
      await within(dialog).findByText(/discards this unit and defers its donor/),
    ).toBeVisible();
    await expectNoAxeViolations();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record screening' }));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        'reactive. The unit was discarded and its donor deferred',
      ),
    );
  });

  it('is offered once only, and never to a unit that is not in testing', async () => {
    await open('BU-0001');
    expect(
      within(rowOf('BU-0001')).getByRole('button', { name: /Record screening/ }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('says so when the server refuses a second screening', async () => {
    await open('BU-0002', 'In testing');
    server.use(
      http.post('*/api/blood-units/:unitId/screening', () =>
        HttpResponse.json(
          { error: { code: 'already_screened', message: 'x', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await press('BU-0002', /Record screening/);
    const dialog = await screen.findByRole('dialog', { name: 'Screening of unit BU-0002' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record screening' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('screened already');
  });

  it('maps screening_required when clearing a unit', async () => {
    addMockBloodUnit({
      id: 'bu_t',
      unitNumber: 'BU-T',
      status: 'testing',
      screeningStatus: 'cleared',
    });
    await open('BU-T', 'In testing');
    server.use(
      http.post('*/api/blood-units/:unitId/move', () =>
        HttpResponse.json(
          { error: { code: 'screening_required', message: 'x', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await press('BU-T', /Clear for stock/);
    expect(await screen.findByRole('alert')).toHaveTextContent('has not been screened clear');
  });
});

describe('cross-matching', () => {
  it('records a cross-match, shows the patient group and 72 hours', async () => {
    await open();
    await press('BU-0001', /Cross-match/);
    const dialog = await screen.findByRole('dialog', { name: 'Cross-match unit BU-0001' });
    expect(within(dialog).getByText('A compatible result is good for 72 hours.')).toBeVisible();
    await pickPatient(dialog);
    expect(await within(dialog).findByText('Patient blood group: O+')).toBeVisible();
    await expectNoAxeViolations();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record cross-match' }));
    await waitFor(() => expect(statusLine()).toHaveTextContent('compatible, good until'));
  });

  it('says a pair that can never match is refused', async () => {
    addMockBloodUnit({ id: 'bu_a', unitNumber: 'BU-A', bloodGroup: 'A+', component: 'red_cells' });
    await open('BU-A');
    await press('BU-A', /Cross-match/);
    const dialog = await screen.findByRole('dialog', { name: 'Cross-match unit BU-A' });
    await pickPatient(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record cross-match' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('can never match');
  });

  it('does not show a blood group to someone who may not read it', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient.bloodGroup:read');
    await open();
    await press('BU-0001', /Cross-match/);
    const dialog = await screen.findByRole('dialog', { name: 'Cross-match unit BU-0001' });
    await pickPatient(dialog);
    expect(await within(dialog).findByText(/blood group is not available to you/)).toBeVisible();
  });

  it('offers it only with bloodUnit:test', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodUnit:test');
    await open();
    expect(screen.queryByRole('button', { name: /Cross-match/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record screening/ })).not.toBeInTheDocument();
  });
});

describe('compatible units for a patient', () => {
  it('lists the units that fit, with their cross-match', async () => {
    await open();
    const panel = screen.getByRole('region', { name: 'Compatible units for a patient' });
    await pickPatient(panel);
    expect(await within(panel).findByText(/1 unit fits a O\+ patient/)).toBeVisible();
    expect(within(panel).getByText(/BU-0001/)).toBeVisible();
    expect(within(panel).getByText('Not cross-matched')).toBeVisible();
    await expectNoAxeViolations();
  });

  it('leaves the patient group out without patient.bloodGroup:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient.bloodGroup:read');
    await open();
    const panel = screen.getByRole('region', { name: 'Compatible units for a patient' });
    await pickPatient(panel);
    expect(await within(panel).findByText(/1 unit fits this patient/)).toBeVisible();
    expect(within(panel).queryByText(/O+ patient/)).not.toBeInTheDocument();
  });

  it('says what the server refused, in plain words', async () => {
    server.use(
      http.post('*/api/blood/compatible-units', () =>
        HttpResponse.json(
          { error: { code: 'blood_group_unknown', message: 'x', requestId: 'req_mock' } },
          { status: 422 },
        ),
      ),
    );
    await open();
    const panel = screen.getByRole('region', { name: 'Compatible units for a patient' });
    await pickPatient(panel);
    expect(await within(panel).findByRole('alert')).toHaveTextContent('no blood group on record');
  });
});

describe('reactions', () => {
  it('records a mild reaction to an issued unit', async () => {
    await open('BU-0003', 'Issued');
    await press('BU-0003', /Record reaction/);
    const dialog = await screen.findByRole('dialog', { name: 'Record a reaction to unit BU-0003' });
    await userEvent.type(within(dialog).getByLabelText(/Transfusion started/), '2026-11-07T08:00');
    await userEvent.type(within(dialog).getByLabelText(/Reaction began/), '2026-11-07T08:30');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Actions taken/ }), 'Stopped');
    await expectNoAxeViolations();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record reaction' }));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent('Reaction to unit BU-0003 recorded.'),
    );
    expect(statusLine()).not.toHaveTextContent('held');
  });

  it('holds the other units of the collection after a severe one', async () => {
    await open('BU-0003', 'Issued');
    await press('BU-0003', /Record reaction/);
    const dialog = await screen.findByRole('dialog', { name: 'Record a reaction to unit BU-0003' });
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: /Severity/ }),
      'Severe',
    );
    expect(
      await within(dialog).findByText(/holds the other units from the same collection/),
    ).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText(/Transfusion started/), '2026-11-07T08:00');
    await userEvent.type(within(dialog).getByLabelText(/Reaction began/), '2026-11-07T08:30');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Actions taken/ }), 'Stopped');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record reaction' }));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        '1 other unit from the same collection was held and discarded',
      ),
    );
  });

  it('is not offered for a unit that was not given, nor without the permission', async () => {
    await open('BU-0001');
    expect(
      within(rowOf('BU-0001')).getByRole('button', { name: /Record reaction/ }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('is hidden without transfusionReaction:record', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'transfusionReaction:record');
    await open();
    expect(screen.queryByRole('button', { name: /Record reaction/ })).not.toBeInTheDocument();
    expect(within(rowOf('BU-0001')).getByRole('button', { name: /Trace/ })).toBeVisible();
  });
});

describe('the trace', () => {
  const trace = async (unit = 'BU-0003', status = 'Issued') => {
    await open(unit, status);
    await press(unit, /Trace/);
    return screen.findByRole('dialog', { name: `Trace of unit ${unit}` });
  };

  it('shows the donor, collection, screening, moves, cross-match and recipient', async () => {
    const dialog = await trace();
    expect(
      await within(dialog).findByText(/Donor DN-0001, group O\+ - Rohan Test-Donor/),
    ).toBeVisible();
    expect(within(dialog).getByText('Cleared')).toBeVisible();
    expect(within(dialog).getByText('No reaction recorded.')).toBeVisible();
    expect(within(dialog).getAllByText(/\(MRN-PTH-00001\)/).length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });

  it('leaves the donor name out when the server sends none', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'bloodDonor:read');
    const dialog = await trace();
    expect(await within(dialog).findByText('Donor DN-0001, group O+')).toBeVisible();
    expect(within(dialog).queryByText(/Rohan/)).not.toBeInTheDocument();
  });

  it('adds an update that can only raise the severity', async () => {
    await open('BU-0003', 'Issued');
    await press('BU-0003', /Record reaction/);
    let dialog = await screen.findByRole('dialog', { name: 'Record a reaction to unit BU-0003' });
    await userEvent.type(within(dialog).getByLabelText(/Transfusion started/), '2026-11-07T08:00');
    await userEvent.type(within(dialog).getByLabelText(/Reaction began/), '2026-11-07T08:30');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Actions taken/ }), 'Stopped');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record reaction' }));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent('Reaction to unit BU-0003 recorded.'),
    );
    await press('BU-0003', /Trace/);
    dialog = await screen.findByRole('dialog', { name: 'Trace of unit BU-0003' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Add update' }));
    const update = await screen.findByRole('dialog', { name: 'Add an update' });
    const severity = within(update).getByRole('combobox', { name: /New severity/ });
    // Mild now: only moderate and severe can be chosen.
    expect(within(severity).queryByRole('option', { name: 'Mild' })).not.toBeInTheDocument();
    await userEvent.selectOptions(severity, 'Moderate');
    await userEvent.type(within(update).getByRole('textbox', { name: /Update/ }), 'Fever rising');
    await userEvent.click(within(update).getByRole('button', { name: 'Add update' }));
    await waitFor(() => expect(within(dialog).getByText('Update recorded.')).toBeVisible());
    expect(await within(dialog).findByText(/raised to Moderate/)).toBeVisible();
  });

  it('says a lowered severity was refused', async () => {
    await open('BU-0003', 'Issued');
    await press('BU-0003', /Record reaction/);
    const first = await screen.findByRole('dialog', { name: 'Record a reaction to unit BU-0003' });
    await userEvent.type(within(first).getByLabelText(/Transfusion started/), '2026-11-07T08:00');
    await userEvent.type(within(first).getByLabelText(/Reaction began/), '2026-11-07T08:30');
    await userEvent.type(within(first).getByRole('textbox', { name: /Actions taken/ }), 'Stopped');
    await userEvent.click(within(first).getByRole('button', { name: 'Record reaction' }));
    await waitFor(() => expect(statusLine()).toHaveTextContent('recorded.'));
    server.use(
      http.post('*/api/transfusion-reactions/:id/updates', () =>
        HttpResponse.json(
          { error: { code: 'severity_not_raised', message: 'x', requestId: 'req_mock' } },
          { status: 422 },
        ),
      ),
    );
    await press('BU-0003', /Trace/);
    const dialog = await screen.findByRole('dialog', { name: 'Trace of unit BU-0003' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Add update' }));
    const update = await screen.findByRole('dialog', { name: 'Add an update' });
    await userEvent.type(within(update).getByRole('textbox', { name: /Update/ }), 'Same');
    await userEvent.click(within(update).getByRole('button', { name: 'Add update' }));
    expect(await within(update).findByRole('alert')).toHaveTextContent('can only be raised');
  });

  it('is hidden without transfusionReaction:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'transfusionReaction:read');
    await open();
    expect(screen.queryByRole('button', { name: /Trace/ })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('has no testing screens at the clinic, whose blood bank is off', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'bloodbank', false);
    signIn(USER_IDS.admin, TENANT_IDS.clinic);
    renderApp({ entry: '/blood-bank' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });
});
