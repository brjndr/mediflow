import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { addMockWardVital } from '@/mocks/handlers/nursing';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const NO_ACCESS = { name: 'You do not have access to this page' };
const GRID = { name: 'Vital sign readings' };

beforeEach(() => {
  addMockAdmission({
    id: 'adm_n1',
    patientName: 'Asha Verma',
    bed: {
      assignmentId: 'a1',
      roomName: 'Room 1',
      bedId: 'b1',
      bedNumber: 'GW-A-01',
      wardId: 'ward_h_gw-a',
      wardName: 'General Ward A',
      assignedAt: '2026-11-08T09:00:00.000Z',
    },
  });
});

const openChart = async () => {
  renderApp({ entry: '/nursing/adm_n1/vitals' });
  await screen.findByRole('heading', { name: /Vital signs: Asha Verma/, level: 1 });
};

describe('the nursing worklist', () => {
  it('lists admitted patients and opens a chart', async () => {
    renderApp({ entry: '/nursing' });
    await screen.findByRole('heading', { name: 'Ward care', level: 1 });
    const grid = await screen.findByRole('table', { name: 'Admitted patients' });
    const row = await within(grid).findByRole('row', { name: /Asha Verma/ });
    expect(within(row).getByText('GW-A-01')).toBeInTheDocument();
    await expectNoAxeViolations();
    await userEvent.click(within(row).getByRole('button', { name: /Chart vitals/ }));
    expect(
      await screen.findByRole('heading', { name: /Vital signs: Asha Verma/ }),
    ).toBeInTheDocument();
  }, 20_000);

  it('is unreachable without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'nursingVitals:read');
    renderApp({ entry: '/nursing' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable with the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'nursing', false);
    renderApp({ entry: '/nursing' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is not offered at the clinic, which has not got it', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'nursingVitals:read');
    grantPermission(TENANT_IDS.hospital, 'doctor', 'admission:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/nursing' });
    await screen.findByRole('heading', { name: 'Ward care', level: 1 });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(screen.queryByRole('link', { name: 'Ward care' })).not.toBeInTheDocument();
  });
});

describe('the vitals chart', () => {
  it('records a reading, scores it and highlights an abnormal value', async () => {
    await openChart();
    await userEvent.type(screen.getByRole('textbox', { name: /Systolic/ }), '85');
    await userEvent.type(screen.getByRole('textbox', { name: /Diastolic/ }), '50');
    await userEvent.type(screen.getByRole('textbox', { name: /Pulse/ }), '118');
    await userEvent.type(screen.getByRole('textbox', { name: /SpO2/ }), '90');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('recorded'));
    const grid = screen.getByRole('table', GRID);
    const row = (await within(grid).findAllByRole('row'))[1] as HTMLElement;
    expect(within(row).getByText('85/50 (low)')).toBeInTheDocument();
    expect(within(row).getByText('Score 8, urgent')).toBeInTheDocument();
    expect(screen.getByText('Ask a doctor to review the patient now.')).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 30_000);

  it('refuses a diastolic pressure without a systolic', async () => {
    await openChart();
    await userEvent.type(screen.getByRole('textbox', { name: /Diastolic/ }), '70');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(
      await screen.findByText('Enter systolic and diastolic pressure together.'),
    ).toBeInTheDocument();
  });

  it('warns when the score is rising and corrects a reading with a reason', async () => {
    addMockWardVital({
      id: 'v1',
      admissionId: 'adm_n1',
      observedAt: '2026-11-08T08:00:00.000Z',
      pulse: 72,
      spo2: 98,
    });
    addMockWardVital({
      id: 'v2',
      admissionId: 'adm_n1',
      observedAt: '2026-11-08T12:00:00.000Z',
      pulse: 125,
      spo2: 93,
      flags: { pulse: 'high', spo2: 'low' },
    });
    await openChart();
    expect(
      await screen.findByText('The score is rising across the latest readings.'),
    ).toBeInTheDocument();
    const grid = screen.getByRole('table', GRID);
    expect(within(grid).getByText('125 (high)')).toBeInTheDocument();
    const rows = within(grid).getAllByRole('row');
    const row = rows.find((each) => within(each).queryByText('125 (high)') !== null);
    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: /Correct/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /Reason/ }), 'Typed wrongly');
    const pulse = screen.getByRole('textbox', { name: /Pulse/ });
    await userEvent.clear(pulse);
    await userEvent.type(pulse, '95');
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Correction saved'));
    await waitFor(() => expect(within(grid).getByText('Corrected')).toBeInTheDocument());
  }, 30_000);

  it('offers no recording without the permission', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'nursingVitals:record');
    await openChart();
    expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument();
  });
});
