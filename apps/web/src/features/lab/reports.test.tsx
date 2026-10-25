import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { addMockLabOrder } from '@/mocks/handlers/clinical';
import { mockReportPrints, mockResultsOf, releaseMockResults } from '@/mocks/handlers/lab';
import { mockPatient } from '@/mocks/handlers/patients';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Reports and result viewing (#92). At the hospital, `ord_h_lab_1` is a complete blood count of
// pth_00001 on the open consultation `enc_h_1`, and `ord_h_lab_2` a haemoglobin of pth_00002.
// Haemoglobin is critical at or below 7 g/dL; the other tests of the count have no critical
// limits. A test releases results as the laboratory would (`releaseMockResults`).

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const CONSULTATION = { name: 'Consultation', level: 1 };
const VISIT_RESULTS = { name: 'Lab results of this visit' };
const COUNT_IN_RANGE = { WBC: '7', PLT: '250', RBC: '5', HCT: '42', MCV: '90' };
const HB = { labTestId: 'lab_h_hb', itemCode: 'HB', itemName: 'Haemoglobin' };

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal('print', print);
});
afterEach(() => {
  vi.unstubAllGlobals();
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

/** Every request to the laboratory's results search, with its address and body. */
function watchSearches(): { url: string; body: Record<string, unknown> }[] {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (new URL(request.url).pathname.endsWith('/lab/results/search')) {
      seen.push({
        url: request.url,
        body: (await request.clone().json()) as Record<string, unknown>,
      });
    }
  });
  return seen;
}

/** The row of a test, or a throw, so `waitFor` tries again while the list is still loading. */
function rowOf(table: HTMLElement, name: string): HTMLElement {
  const row = within(table)
    .getAllByRole('row')
    .find((each) => within(each).queryAllByRole('cell')[0]?.textContent === name);
  if (!row) throw new Error(`no row of ${name}`);
  return row;
}

async function openConsultation() {
  renderApp({ entry: '/encounters/enc_h_1' });
  await screen.findByRole('heading', CONSULTATION);
}

describe('results in the consultation', () => {
  it('shows the visit’s verified results and has the doctor acknowledge a critical one', async () => {
    const released = releaseMockResults(HOSPITAL, 'ord_h_lab_1', { HB: '5.4', ...COUNT_IN_RANGE });
    const searches = watchSearches();
    signIn(USER_IDS.doctor, HOSPITAL);
    await openConsultation();
    const table = await screen.findByRole('table', VISIT_RESULTS);
    const row = await waitFor(() => rowOf(table, 'Haemoglobin'));
    expect(within(row).getByText('5.4 g/dL')).toBeInTheDocument();
    expect(within(row).getByText('Critical low')).toBeInTheDocument();
    expect(within(row).getByText('Critical, not acknowledged')).toBeInTheDocument();
    expect(within(rowOf(table, 'Platelet count')).getByText('250 10^3/uL')).toBeInTheDocument();
    expect(screen.getByText('1 critical result needs acknowledging.')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Haemoglobin' })).toHaveAttribute(
      'href',
      '/lab/orders/ord_h_lab_1',
    );
    // The patient and the visit travel in the body, never in the address.
    expect(searches[0]?.body).toMatchObject({ patientId: 'pth_00001', encounterId: 'enc_h_1' });
    expect(searches[0]?.url).not.toMatch(/pth_00001|enc_h_1/);
    // The results line of the orders panel is gone.
    expect(screen.queryByText(/arrive with the laboratory/)).not.toBeInTheDocument();
    await expectNoAxeViolations();

    const button = within(row).getByRole('button', { name: /^Acknowledge/ });
    await userEvent.click(button);
    expect(
      (await screen.findByText('Critical result of Haemoglobin acknowledged.')).closest(
        '[role="status"]',
      ),
    ).toBeInTheDocument();
    // The button stays, now with nothing to do, so the keyboard keeps its place.
    await waitFor(() => {
      const again = within(
        rowOf(screen.getByRole('table', VISIT_RESULTS), 'Haemoglobin'),
      ).getByRole('button', { name: /^Acknowledge/ });
      expect(again).toHaveAttribute('aria-disabled', 'true');
      expect(again).toHaveFocus();
    });
    await waitFor(() =>
      expect(
        within(rowOf(screen.getByRole('table', VISIT_RESULTS), 'Haemoglobin')).getByText(
          /^Acknowledged by Sample Doctor/,
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/needs acknowledging/)).not.toBeInTheDocument();
    const hb = mockResultsOf(released[0]?.sampleId ?? '').find((each) => each.testCode === 'HB');
    expect(hb?.acknowledgedByName).toBe('Sample Doctor');
    // The whole consultation is drawn and checked by axe: slow on a busy machine.
  }, 15_000);

  it('says so when another doctor acknowledged it meanwhile', async () => {
    const results = releaseMockResults(HOSPITAL, 'ord_h_lab_1', { HB: '5', ...COUNT_IN_RANGE });
    const hb = results.find((each) => each.testCode === 'HB');
    await openConsultation();
    const table = await screen.findByRole('table', VISIT_RESULTS);
    const row = await waitFor(() => rowOf(table, 'Haemoglobin'));
    await post(`/lab/results/${hb?.id}/acknowledge`);
    await userEvent.click(within(row).getByRole('button', { name: /^Acknowledge/ }));
    expect(
      await screen.findByText(
        'Someone acknowledged Haemoglobin meanwhile. The results were read again.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(rowOf(screen.getByRole('table', VISIT_RESULTS), 'Haemoglobin')).getByText(
          /^Acknowledged by/,
        ),
      ).toBeInTheDocument(),
    );
  });

  it('shows the words but no acknowledging without labResult:acknowledge', async () => {
    releaseMockResults(HOSPITAL, 'ord_h_lab_1', { HB: '5', ...COUNT_IN_RANGE });
    revokePermission(HOSPITAL, 'admin', 'labResult:acknowledge');
    await openConsultation();
    const table = await screen.findByRole('table', VISIT_RESULTS);
    const row = await waitFor(() => rowOf(table, 'Haemoglobin'));
    expect(within(row).getByText('Critical, not acknowledged')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^Acknowledge/ })).toBeNull();
  });

  it('leaves no trace and reads nothing without labResult:read, or with the laboratory off', async () => {
    const searches = watchSearches();
    revokePermission(HOSPITAL, 'admin', 'labResult:read');
    const app = renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', CONSULTATION);
    await screen.findByRole('table', { name: 'Lab orders' });
    expect(screen.queryByRole('heading', VISIT_RESULTS)).toBeNull();
    app.unmount();

    signIn(USER_IDS.admin, HOSPITAL);
    setTenantFeature(HOSPITAL, 'laboratory', false);
    await openConsultation();
    await screen.findByRole('table', { name: 'Lab orders' });
    expect(screen.queryByRole('heading', VISIT_RESULTS)).toBeNull();
    expect(searches).toEqual([]);
  });
});

describe('results on the patient’s screen', () => {
  async function openTab(id = 'pth_00001') {
    renderApp({ entry: `/patients/${id}?tab=lab-results` });
    await screen.findByRole('tab', { name: 'Lab results', selected: true });
    return screen.findByRole('table', { name: 'Lab results' });
  }

  it('lists the newest first and draws a test’s trend', async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 4)).toISOString();
    releaseMockResults(
      HOSPITAL,
      addMockLabOrder('enc_h_1', HB),
      { HB: '10.5' },
      { collectedAt: day(1) },
    );
    releaseMockResults(
      HOSPITAL,
      addMockLabOrder('enc_h_1', HB),
      { HB: '12.1' },
      { collectedAt: day(8) },
    );
    const table = await openTab();
    const rows = await waitFor(() => {
      const found = within(table).getAllByRole('row').slice(1);
      expect(found).toHaveLength(2);
      return found;
    });
    expect(within(rows[0]!).getByText('12.1 g/dL')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('10.5 g/dL')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Low')).toBeInTheDocument();
    await expectNoAxeViolations();

    await userEvent.click(within(rows[0]!).getByRole('button', { name: /^Show trend/ }));
    const heading = await screen.findByRole('heading', { name: 'Trend of Haemoglobin' });
    expect(heading).toHaveFocus();
    const figure = await screen.findByRole('figure', { name: /^Trend of Haemoglobin\./ });
    // The same numbers as a table, oldest first, for a screen reader and on request.
    const values = within(figure)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(values).toHaveLength(2);
    expect(values[0]).toMatch(/10\.5$/);
    expect(values[1]).toMatch(/12\.1$/);
    expect(screen.getByText(/^Reference range of the newest result: /)).toBeInTheDocument();
    await expectNoAxeViolations();

    await userEvent.click(screen.getByRole('button', { name: 'Close trend' }));
    expect(screen.queryByRole('heading', { name: 'Trend of Haemoglobin' })).toBeNull();
    expect(
      within(screen.getByRole('table', { name: 'Lab results' })).getAllByRole('button', {
        name: /^Show trend/,
      })[0],
    ).toHaveFocus();
  });

  it('says a trend needs two results', async () => {
    releaseMockResults(HOSPITAL, addMockLabOrder('enc_h_1', HB), { HB: '13' });
    const table = await openTab();
    const row = await waitFor(() => rowOf(table, 'Haemoglobin'));
    await userEvent.click(within(row).getByRole('button', { name: /^Show trend/ }));
    expect(
      await screen.findByText('A trend needs at least two verified results of this test.'),
    ).toBeInTheDocument();
  });

  it('is not offered without labResult:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'labResult:read');
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tab', { name: 'Clinical timeline' });
    expect(screen.queryByRole('tab', { name: 'Lab results' })).toBeNull();
  });

  it('keeps each hospital’s results to itself', async () => {
    releaseMockResults(HOSPITAL, 'ord_h_lab_2', { HB: '13' });
    setTenantFeature(CLINIC, 'laboratory', true);
    signIn(USER_IDS.doctor, CLINIC);
    setRolePermissions(CLINIC, 'doctor', [{ permission: 'labResult:read' }]);
    expect(await post('/lab/results/search', { patientId: 'pth_00002' })).toMatchObject({
      items: [],
    });
  });
});

describe('the printed report', () => {
  const HEADING = { name: 'Results: Haemoglobin', level: 1 };

  async function printedSheet(): Promise<HTMLElement> {
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
    if (!sheet) throw new Error('nothing to print');
    return sheet;
  }

  it('records the print, then prints the letterhead, the patient and the verified results', async () => {
    releaseMockResults(HOSPITAL, 'ord_h_lab_2', { HB: '13.0' });
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    await screen.findByRole('heading', HEADING);
    await userEvent.click(screen.getByRole('button', { name: 'Print report' }));
    const sheet = await printedSheet();
    expect(mockReportPrints()).toEqual([
      { tenantId: HOSPITAL, orderId: 'ord_h_lab_2', userId: USER_IDS.admin },
    ]);
    expect(within(sheet).getByText('Sample Hospital')).toBeInTheDocument();
    expect(
      within(sheet).getByRole('heading', { name: 'Laboratory report: Haemoglobin' }),
    ).toBeInTheDocument();
    const patient = mockPatient(HOSPITAL, 'pth_00002');
    // On paper for the patient: the whole MRN.
    expect(within(sheet).getByText(`${patient?.name}, MRN ${patient?.mrn}`)).toBeInTheDocument();
    expect(within(sheet).getByText('13.0 g/dL')).toBeInTheDocument();
    expect(within(sheet).getByText('Normal')).toBeInTheDocument();
    expect(within(sheet).getByText('Verified by Lab Technician')).toBeInTheDocument();
    expect(within(sheet).getByText(/^Printed .* by Sample Admin$/)).toBeInTheDocument();
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());
    await expectNoAxeViolations();
  });

  it('prints a test still to verify as pending, never with its value', async () => {
    const sample = await post('/lab/orders/ord_h_lab_1/samples');
    await post(`/lab/samples/${sample.id}/receive`, { version: 1 });
    await post(`/lab/samples/${sample.id}/results`, {
      results: [
        { labTestId: 'lab_h_hb', value: '13.5' },
        { labTestId: 'lab_h_plt', value: '260' },
      ],
    });
    const hb = mockResultsOf(sample.id).find((each) => each.testCode === 'HB');
    await post(`/lab/samples/${sample.id}/verify`, { resultIds: [hb?.id] });
    renderApp({ entry: '/lab/orders/ord_h_lab_1' });
    await screen.findByRole('heading', { name: 'Results: Complete blood count', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Print report' }));
    const sheet = await printedSheet();
    expect(within(sheet).getByText('13.5 g/dL')).toBeInTheDocument();
    expect(within(sheet).queryByText(/^260/)).toBeNull();
    expect(within(sheet).getAllByText('Pending')).toHaveLength(5);
    expect(
      within(sheet).getByText('A test marked pending is reported once it is verified.'),
    ).toBeInTheDocument();
  });

  it('prints nothing and says why when the print is refused', async () => {
    releaseMockResults(HOSPITAL, 'ord_h_lab_2', { HB: '13' });
    server.use(
      http.post('*/api/lab/orders/:orderId/print', () =>
        HttpResponse.json(
          { error: { code: 'not_printable', message: 'No verified result' } },
          { status: 409 },
        ),
      ),
    );
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    await screen.findByRole('heading', HEADING);
    await userEvent.click(screen.getByRole('button', { name: 'Print report' }));
    expect(
      await screen.findByText('Nothing to print yet: no result of this order is verified.'),
    ).toBeInTheDocument();
    expect(print).not.toHaveBeenCalled();
    expect(document.querySelector('[data-print-sheet]')).toBeNull();
  });

  it('is offered for labReport:print once a result is verified', async () => {
    const app = renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    await screen.findByRole('heading', HEADING);
    expect(screen.queryByRole('button', { name: 'Print report' })).toBeNull();
    app.unmount();

    releaseMockResults(HOSPITAL, 'ord_h_lab_2', { HB: '13' });
    revokePermission(HOSPITAL, 'admin', 'labReport:print');
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    await screen.findByRole('heading', HEADING);
    expect(screen.getByText('13 g/dL')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Print report' })).toBeNull();
  });

  it('has the doctor acknowledge a critical result on the results page too', async () => {
    releaseMockResults(HOSPITAL, 'ord_h_lab_2', { HB: '6' });
    signIn(USER_IDS.doctor, HOSPITAL);
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    await screen.findByRole('heading', HEADING);
    expect(screen.getByText('Critical, not acknowledged')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Acknowledge/ }));
    expect(
      await screen.findByText('Critical result of Haemoglobin acknowledged.'),
    ).toBeInTheDocument();
    expect(await screen.findByText(/^Acknowledged by Sample Doctor/)).toBeInTheDocument();
  });
});
