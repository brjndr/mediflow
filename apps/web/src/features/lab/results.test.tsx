import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockOrdersOf } from '@/mocks/handlers/clinical';
import { mockResultsOf, mockSamplesOf } from '@/mocks/handlers/lab';
import { mockPatient } from '@/mocks/handlers/patients';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Result entry and verification (#91). `ord_h_lab_2` is a haemoglobin of pth_00002 and
// `ord_h_lab_1` a complete blood count (a panel of six tests) of pth_00001, both at the hospital.
// A test collects and receives the sample first, as the laboratory would.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const HEADING = { name: 'Results: Haemoglobin', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

afterEach(() => {
  server.events.removeAllListeners();
});

/** Calls the mock as another member of staff would, behind the open screen. */
async function post(path: string, body?: unknown) {
  const response = await fetch(new URL(`/api${path}`, window.location.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, unknown> & { id: string };
}

/** Collects and receives the order's sample, as the worklist would. */
async function received(orderId = 'ord_h_lab_2') {
  const sample = await post(`/lab/orders/${orderId}/samples`);
  await post(`/lab/samples/${sample.id}/receive`, { version: 1 });
  return sample.id;
}

async function openResults(orderId = 'ord_h_lab_2', heading = HEADING) {
  renderApp({ entry: `/lab/orders/${orderId}` });
  await screen.findByRole('heading', heading);
}

/** The page's status line, found by what it says. */
const statusLine = async (text: RegExp | string) =>
  (await screen.findByText(text)).closest('[role="status"]');

const resultsGrid = () => screen.getByRole('table', { name: /^Results of / });
const rowOf = (name: string) =>
  within(resultsGrid())
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent === name) as HTMLElement;

describe('entering and verifying results', () => {
  it('enters a number, says it is critical, and verifies it, completing the order', async () => {
    const sampleId = await received();
    await openResults();
    expect(screen.getByText(mockPatient(HOSPITAL, 'pth_00002')?.name ?? '')).toBeInTheDocument();
    // The MRN is masked.
    expect(screen.queryByText(mockPatient(HOSPITAL, 'pth_00002')?.mrn ?? '')).toBeNull();
    expect(within(rowOf('Haemoglobin')).getByText('Not entered')).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Haemoglobin (g/dL)' });
    expect(field).toHaveAttribute('inputmode', 'decimal');
    expect(field).toHaveAccessibleDescription(/^Reference range: .*critical at or below/);

    await userEvent.type(field, '5.10');
    await userEvent.click(screen.getByRole('button', { name: 'Save results' }));
    const status = await statusLine(/1 result saved, to verify\. Critical: Haemoglobin/);
    expect(status).toHaveFocus();
    const row = rowOf('Haemoglobin');
    expect(within(row).getByText('5.10 g/dL')).toBeInTheDocument();
    expect(within(row).getByText('Critical low')).toBeInTheDocument();
    expect(within(row).getByText('Not verified')).toBeInTheDocument();
    expect(mockOrdersOf('enc_h_2').find((o) => o.id === 'ord_h_lab_2')?.status).toBe('in_progress');
    await expectNoAxeViolations(document.body);

    const tick = screen.getByRole('checkbox', { name: 'Haemoglobin: 5.10 g/dL, Critical low' });
    expect(tick).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Verify ticked results' }));
    expect(
      await screen.findByText(/Every result of the order is verified: the order is completed/),
    ).toBeInTheDocument();
    expect(within(rowOf('Haemoglobin')).getByText(/^Verified by /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify ticked results' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save results' })).toBeNull();
    expect(mockResultsOf(sampleId).map((r) => r.status)).toEqual(['verified']);
    expect(mockOrdersOf('enc_h_2').find((o) => o.id === 'ord_h_lab_2')?.status).toBe('completed');
  });

  it('refuses a number the laboratory does not take, and an empty entry', async () => {
    await received('ord_h_lab_1');
    await openResults('ord_h_lab_1', { name: 'Results: Complete blood count', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Save results' }));
    expect(await screen.findByText('Enter at least one result.')).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: /^Haemoglobin/ });
    expect(field).toHaveFocus();
    await userEvent.type(field, '.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save results' }));
    expect(await screen.findByText('Enter a number, such as 5.1 or -0.25.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');

    // Some tests of the panel now, the rest later: only what is filled in is sent.
    await userEvent.clear(field);
    await userEvent.type(field, '13.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save results' }));
    await screen.findByText(/1 result saved/);
    expect(within(rowOf('Haemoglobin')).getByText('Normal')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Haemoglobin/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: /^Platelet/ })).toBeInTheDocument();
  });

  it('keeps what was typed in the other tests when someone else entered one meanwhile', async () => {
    const sampleId = await received('ord_h_lab_1');
    await openResults('ord_h_lab_1', { name: 'Results: Complete blood count', level: 1 });
    await userEvent.type(screen.getByRole('textbox', { name: /^Haemoglobin/ }), '13.5');
    await userEvent.type(screen.getByRole('textbox', { name: /^Platelet/ }), '250');
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '14' }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save results' }));
    // Said in the status line; the form stays, so the button pressed keeps focus.
    expect(await statusLine(/Someone else entered a result meanwhile/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save results' })).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /^Haemoglobin/ })).toBeNull());
    expect(within(rowOf('Haemoglobin')).getByText('14 g/dL')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Platelet/ })).toHaveValue('250');
  });

  it('says so in its panel when a result was corrected meanwhile, and offers no resend', async () => {
    const sampleId = await received();
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '13' }],
    });
    await openResults();
    await userEvent.click(within(rowOf('Haemoglobin')).getByRole('button', { name: /^Correct/ }));
    const panel = screen.getByRole('region', { name: 'Correct Haemoglobin' });
    await post(`/lab/results/${mockResultsOf(sampleId)[0]?.id ?? ''}/amend`, {
      value: '12',
      reason: 'Recalibrated',
    });
    await userEvent.type(within(panel).getByRole('textbox', { name: /^Corrected result/ }), '14');
    await userEvent.type(
      within(panel).getByRole('textbox', { name: /^Reason for the correction/ }),
      'Typo',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Save correction' }));
    expect(await within(panel).findByText(/This result was corrected meanwhile/)).toHaveFocus();
    expect(within(panel).queryByRole('button', { name: 'Save correction' })).toBeNull();
    expect(mockResultsOf(sampleId)).toHaveLength(2);
  });

  it('says so when someone else verified a result meanwhile, and reads the results again', async () => {
    const sampleId = await received();
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '13' }],
    });
    await openResults();
    const resultId = mockResultsOf(sampleId)[0]?.id;
    await post(`/lab/samples/${sampleId}/verify`, { resultIds: [resultId] });
    await userEvent.click(screen.getByRole('button', { name: 'Verify ticked results' }));
    expect(await statusLine(/A result changed meanwhile/)).toHaveFocus();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Verify ticked results' })).toBeNull(),
    );
    expect(within(rowOf('Haemoglobin')).getByText(/^Verified by /)).toBeInTheDocument();
  });

  it('corrects a verified result with a reason, keeps the history and verifies it again', async () => {
    const sampleId = await received();
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '13' }],
    });
    await post(`/lab/samples/${sampleId}/verify`, {
      resultIds: [mockResultsOf(sampleId)[0]?.id],
    });
    await openResults();
    const correct = within(rowOf('Haemoglobin')).getByRole('button', { name: /^Correct/ });
    await userEvent.click(correct);
    const panel = screen.getByRole('region', { name: 'Correct Haemoglobin' });
    expect(within(panel).getByRole('heading', { name: 'Correct Haemoglobin' })).toHaveFocus();
    await userEvent.type(within(panel).getByRole('textbox', { name: /^Corrected result/ }), '14.2');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save correction' }));
    expect(await within(panel).findByText('Say why the result is corrected.')).toBeInTheDocument();
    await userEvent.type(
      within(panel).getByRole('textbox', { name: /^Reason for the correction/ }),
      'Transcription error',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Save correction' }));
    expect(await statusLine('Haemoglobin corrected, to verify again.')).toHaveFocus();
    expect(within(rowOf('Haemoglobin')).getByText('14.2 g/dL')).toBeInTheDocument();
    expect(within(rowOf('Haemoglobin')).getByText('Not verified')).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Corrections' });
    expect(within(history).getByText(/Haemoglobin: 13 g\/dL, replaced/)).toBeInTheDocument();
    expect(within(history).getByText('Reason: Transcription error')).toBeInTheDocument();
    expect(mockResultsOf(sampleId)).toHaveLength(2);
    expect(screen.getByRole('checkbox', { name: /^Haemoglobin: 14.2 g\/dL/ })).toBeInTheDocument();
  });
});

describe('what the doctor sees', () => {
  it('never shows a result before it is verified, and shows it once it is', async () => {
    const sampleId = await received();
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '5' }],
    });
    signIn(USER_IDS.doctor, HOSPITAL);
    const app = renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    await screen.findByRole('heading', HEADING);
    const row = rowOf('Haemoglobin');
    expect(within(row).getByText('Awaiting verification')).toBeInTheDocument();
    expect(within(row).queryByText(/^5/)).toBeNull();
    expect(within(row).queryByText('Critical low')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify ticked results' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Correct/ })).toBeNull();
    // The laboratory's worklist is not the doctor's.
    expect(screen.queryByRole('link', { name: 'Laboratory' })).toBeNull();
    await expectNoAxeViolations(document.body);
    app.unmount();

    signIn(USER_IDS.admin, HOSPITAL);
    await post(`/lab/samples/${sampleId}/verify`, {
      resultIds: [mockResultsOf(sampleId)[0]?.id],
    });
    signIn(USER_IDS.doctor, HOSPITAL);
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    await screen.findByRole('heading', HEADING);
    expect(within(rowOf('Haemoglobin')).getByText('5 g/dL')).toBeInTheDocument();
    expect(within(rowOf('Haemoglobin')).getByText('Critical low')).toBeInTheDocument();
  });
});

describe('what the doctor sees while a correction waits', () => {
  it('keeps the replaced result as history, and the test awaiting verification', async () => {
    const sampleId = await received();
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '13' }],
    });
    const first = mockResultsOf(sampleId)[0]?.id ?? '';
    await post(`/lab/samples/${sampleId}/verify`, { resultIds: [first] });
    await post(`/lab/results/${first}/amend`, { value: '9', reason: 'Wrong tube' });
    signIn(USER_IDS.doctor, HOSPITAL);
    await openResults();
    expect(within(rowOf('Haemoglobin')).getByText('Awaiting verification')).toBeInTheDocument();
    expect(within(rowOf('Haemoglobin')).queryByText(/g\/dL/)).toBeNull();
    const history = screen.getByRole('region', { name: 'Corrections' });
    expect(within(history).getByText(/Haemoglobin: 13 g\/dL, replaced/)).toBeInTheDocument();
    // The correction itself, its value and its reason, are not the doctor's until verified.
    expect(screen.queryByText(/9 g\/dL/)).toBeNull();
    expect(screen.queryByText(/Wrong tube/)).toBeNull();
  });
});

describe('the worklist and who reaches results', () => {
  it('opens a received order’s results, and lists it as completed once verified', async () => {
    const sampleId = await received();
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '13' }],
    });
    renderApp({ entry: '/lab' });
    await screen.findByRole('heading', { name: 'Laboratory worklist', level: 1 });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'Received');
    const grid = screen.getByRole('table', { name: 'Laboratory worklist' });
    expect(await within(grid).findByText('1 entered, 1 to verify')).toBeInTheDocument();
    await post(`/lab/samples/${sampleId}/verify`, {
      resultIds: [mockResultsOf(sampleId)[0]?.id],
    });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'Completed');
    expect(await within(grid).findByText('1 verified')).toBeInTheDocument();
    await userEvent.click(within(grid).getByRole('button', { name: /^Results/ }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('offers neither entry nor verifying to a role that only reads results', async () => {
    await received();
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'labSample:read' },
      { permission: 'labResult:read' },
    ]);
    await openResults();
    expect(screen.queryByRole('button', { name: 'Save results' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Correct/ })).toBeNull();
  });

  it('lets a custom role enter results but not verify them', async () => {
    const sampleId = await received();
    await post(`/lab/samples/${sampleId}/results`, {
      results: [{ labTestId: 'lab_h_hb', value: '13' }],
    });
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'labResult:read' },
      { permission: 'labResult:enter' },
    ]);
    await openResults();
    // It enters, so it sees what it entered, marked as not verified.
    expect(within(rowOf('Haemoglobin')).getByText('13 g/dL')).toBeInTheDocument();
    expect(within(rowOf('Haemoglobin')).getByText('Not verified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify ticked results' })).toBeNull();
    expect(
      within(rowOf('Haemoglobin')).getByRole('button', { name: /^Correct/ }),
    ).toBeInTheDocument();
  });

  it('is unreachable without labResult:read, and with the laboratory off', async () => {
    revokePermission(HOSPITAL, 'admin', 'labResult:read');
    const app = renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    app.unmount();

    setTenantFeature(HOSPITAL, 'laboratory', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('keeps each hospital’s results to itself', async () => {
    const sampleId = await received();
    setTenantFeature(CLINIC, 'laboratory', true);
    signIn(USER_IDS.doctor, CLINIC);
    setRolePermissions(CLINIC, 'doctor', [
      { permission: 'labResult:read' },
      { permission: 'labResult:enter' },
      { permission: 'labResult:verify' },
    ]);
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    expect(await screen.findByText('This lab order is not available.')).toBeInTheDocument();
    expect(
      await post(`/lab/samples/${sampleId}/results`, {
        results: [{ labTestId: 'lab_h_hb', value: '13' }],
      }),
    ).toMatchObject({ error: { code: 'sample_not_found' } });
    expect(mockResultsOf(sampleId)).toHaveLength(0);
    expect(mockSamplesOf('ord_h_lab_2')[0]?.status).toBe('received');
  });
});
