import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockOrdersOf } from '@/mocks/handlers/clinical';
import { mockLabelPrints, mockSamplesOf } from '@/mocks/handlers/lab';
import { mockPatient } from '@/mocks/handlers/patients';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The laboratory worklist (#90). The clinical mock's hospital has two routine lab orders placed:
// `ord_h_lab_1`, a complete blood count of pth_00001 (enc_h_1, open), and `ord_h_lab_2`, a
// haemoglobin of pth_00002 (enc_h_2, closed, so ordered first). The clinic has the laboratory
// switched off.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const LIST = { name: 'Laboratory worklist', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const ACCESSION = /^\d{6}-\d{4}$/;

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal('print', print);
});
afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

const first = () => mockPatient(HOSPITAL, 'pth_00001')?.name ?? '';
const second = () => mockPatient(HOSPITAL, 'pth_00002')?.name ?? '';
const grid = () => screen.getByRole('table', { name: LIST.name });
const rowNames = () =>
  within(grid())
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');
const named = (...names: string[]) => names.map((name) => expect.stringContaining(name));

/** Calls the mock as another member of staff would, behind the open screen. */
async function post(path: string, body?: unknown) {
  const response = await fetch(new URL(`/api${path}`, window.location.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.status === 204 ? null : ((await response.json()) as Record<string, unknown>);
}

async function openWorklist() {
  renderApp({ entry: '/lab' });
  await screen.findByRole('heading', LIST);
  await within(grid()).findByText(first());
}

const chooseStage = (stage: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), stage);

describe('the laboratory worklist', () => {
  it('lists the orders to collect, stat first and the oldest first within a priority', async () => {
    await post('/encounters/enc_h_1/orders', {
      type: 'lab',
      labTestId: 'lab_h_hb',
      priority: 'stat',
    });
    renderApp({ entry: '/lab' });
    await screen.findByRole('heading', LIST);
    await waitFor(() => expect(rowNames()).toEqual(named(first(), second(), first())));
    const rows = within(grid()).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('Stat')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Complete blood count')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Blood, not collected')).toBeInTheDocument();
    expect(screen.getByText('3 orders')).toBeInTheDocument();
    // The MRN is masked in the list.
    expect(within(grid()).queryByText(mockPatient(HOSPITAL, 'pth_00001')?.mrn ?? '')).toBeNull();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'Stat');
    await waitFor(() => expect(rowNames()).toEqual(named(first())));
    await expectNoAxeViolations(document.body);
  });

  it(
    'collects a sample after the patient is checked, and prints its label',
    { timeout: 15_000 },
    async () => {
      await openWorklist();
      await userEvent.click(
        within(grid()).getByRole('button', {
          name: `Collect sample: ${first()}, Complete blood count`,
        }),
      );
      const panel = await screen.findByRole('region', {
        name: 'Collect sample: Complete blood count',
      });
      expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();
      expect(within(panel).getByText(first())).toBeInTheDocument();
      expect(
        within(panel).getByText(mockPatient(HOSPITAL, 'pth_00001')?.mrn ?? ''),
      ).toBeInTheDocument();
      expect(within(panel).getByText('Date of birth')).toBeInTheDocument();
      await expectNoAxeViolations(document.body);

      await userEvent.click(within(panel).getByRole('button', { name: 'Mark as collected' }));
      const [sample] = mockSamplesOf('ord_h_lab_1');
      expect(sample?.accessionId).toMatch(ACCESSION);
      expect(await within(panel).findByRole('status')).toHaveTextContent(
        `Collected as ${sample?.accessionId}.`,
      );
      expect(mockOrdersOf('enc_h_1').find((each) => each.id === 'ord_h_lab_1')?.status).toBe(
        'accepted',
      );
      // Collected, it leaves the orders to collect; the panel stays to print the label, on the
      // button that was pressed.
      await waitFor(() => expect(within(grid()).queryByText('Complete blood count')).toBeNull());
      expect(within(panel).getByRole('button', { name: 'Print label' })).toHaveFocus();

      await userEvent.click(within(panel).getByRole('button', { name: 'Print label' }));
      await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
      expect(mockLabelPrints()).toEqual([
        { tenantId: HOSPITAL, sampleId: sample?.id, userId: USER_IDS.admin },
      ]);
      const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
      expect(sheet).toHaveTextContent(sample?.accessionId ?? '');
      expect(sheet).toHaveTextContent(first());
      expect(
        within(sheet as HTMLElement).getByRole('img', {
          name: `Barcode of ${sample?.accessionId}`,
        }),
      ).toBeInTheDocument();
      window.dispatchEvent(new Event('afterprint'));
      await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());

      // The row it was opened from left the list: focus goes to the status line.
      await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
      expect(screen.getByText('1 order')).toHaveFocus();
      await chooseStage('Collected');
      expect(
        await within(grid()).findByText(`${sample?.accessionId}, collected`),
      ).toBeInTheDocument();
    },
  );

  it('says so when someone else collected the sample meanwhile', async () => {
    await openWorklist();
    await userEvent.click(
      within(grid()).getByRole('button', {
        name: `Collect sample: ${first()}, Complete blood count`,
      }),
    );
    const panel = await screen.findByRole('region', { name: /^Collect sample/ });
    await post('/lab/orders/ord_h_lab_1/samples');
    await userEvent.click(within(panel).getByRole('button', { name: 'Mark as collected' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('Someone else already collected this sample.');
    expect(alert).toHaveFocus();
    expect(within(panel).queryByRole('button', { name: 'Mark as collected' })).toBeNull();
    expect(mockSamplesOf('ord_h_lab_1')).toHaveLength(1);
  });

  it('receives a collected sample, and the order stays accepted until a result', async () => {
    const collected = await post('/lab/orders/ord_h_lab_2/samples');
    renderApp({ entry: '/lab' });
    await screen.findByRole('heading', LIST);
    await chooseStage('Collected');
    await within(grid()).findByText(second());
    await userEvent.click(
      within(grid()).getByRole('button', { name: `Receive: ${second()}, Haemoglobin` }),
    );
    expect(
      await screen.findByText(new RegExp(`^Sample ${String(collected?.accessionId)} received`)),
    ).toHaveFocus();
    expect(mockSamplesOf('ord_h_lab_2')[0]?.status).toBe('received');
    expect(mockOrdersOf('enc_h_2').find((each) => each.id === 'ord_h_lab_2')?.status).toBe(
      'accepted',
    );
    await waitFor(() => expect(within(grid()).queryByText(second())).toBeNull());
  });

  it('says so when a sample was received meanwhile, and offers no resend', async () => {
    const collected = await post('/lab/orders/ord_h_lab_2/samples');
    renderApp({ entry: '/lab' });
    await screen.findByRole('heading', LIST);
    await chooseStage('Collected');
    await within(grid()).findByText(second());
    await userEvent.click(
      within(grid()).getByRole('button', { name: `Reject: ${second()}, Haemoglobin` }),
    );
    const panel = await screen.findByRole('region', { name: /^Reject sample/ });
    await post(`/lab/samples/${String(collected?.id)}/receive`, { version: 1 });
    await userEvent.selectOptions(
      within(panel).getByRole('combobox', { name: /^Reason/ }),
      'Clotted',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Reject sample' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('This sample changed meanwhile.');
    expect(alert).toHaveFocus();
    expect(within(panel).queryByRole('button', { name: 'Reject sample' })).toBeNull();
    expect(mockSamplesOf('ord_h_lab_2')[0]?.status).toBe('received');
  });

  it('says why a receive or a label print was refused', async () => {
    const collected = await post('/lab/orders/ord_h_lab_2/samples');
    renderApp({ entry: '/lab' });
    await screen.findByRole('heading', LIST);
    await chooseStage('Collected');
    await within(grid()).findByText(second());
    const id = String(collected?.id);

    // Someone received it meanwhile, from the version this list read.
    await post(`/lab/samples/${id}/receive`, { version: 1 });
    await userEvent.click(
      within(grid()).getByRole('button', { name: `Receive: ${second()}, Haemoglobin` }),
    );
    expect(
      await screen.findByText(/^This sample changed meanwhile. The worklist was read again./),
    ).toHaveFocus();

    // Rejected meanwhile: its label is not printed.
    await chooseStage('Received');
    await within(grid()).findByText(second());
    await post(`/lab/samples/${id}/reject`, { version: 2, reason: 'clotted' });
    await userEvent.click(
      within(grid()).getByRole('button', { name: `Print label: ${second()}, Haemoglobin` }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sample was rejected: its label is not printed.',
    );
    expect(print).not.toHaveBeenCalled();
    expect(mockLabelPrints()).toHaveLength(0);
    // Changing the stage lets the message go.
    await chooseStage('To collect');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('refuses to reject a sample once its order was cancelled', async () => {
    const collected = await post('/lab/orders/ord_h_lab_2/samples');
    renderApp({ entry: '/lab' });
    await screen.findByRole('heading', LIST);
    await chooseStage('Collected');
    await within(grid()).findByText(second());
    await userEvent.click(
      within(grid()).getByRole('button', { name: `Reject: ${second()}, Haemoglobin` }),
    );
    const panel = await screen.findByRole('region', { name: /^Reject sample/ });
    await post('/orders/ord_h_lab_2/cancel', { reason: 'Not needed', version: 2 });
    await userEvent.selectOptions(
      within(panel).getByRole('combobox', { name: /^Reason/ }),
      'Clotted',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Reject sample' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'This sample can no longer be rejected.',
    );
    expect(mockSamplesOf('ord_h_lab_2')[0]?.id).toBe(collected?.id);
    expect(mockSamplesOf('ord_h_lab_2')[0]?.status).toBe('collected');
  });

  it(
    'rejects a sample with a reason, and the order is collected again as a new sample',
    { timeout: 15_000 },
    async () => {
      const collected = await post('/lab/orders/ord_h_lab_2/samples');
      renderApp({ entry: '/lab' });
      await screen.findByRole('heading', LIST);
      await chooseStage('Collected');
      await within(grid()).findByText(second());
      await userEvent.click(
        within(grid()).getByRole('button', { name: `Reject: ${second()}, Haemoglobin` }),
      );
      const panel = await screen.findByRole('region', {
        name: `Reject sample ${String(collected?.accessionId)}`,
      });

      // Nothing chosen, then Other without a note.
      await userEvent.click(within(panel).getByRole('button', { name: 'Reject sample' }));
      expect(await within(panel).findByText('Choose a reason.')).toBeInTheDocument();
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Reason/ }),
        'Other',
      );
      await userEvent.click(within(panel).getByRole('button', { name: 'Reject sample' }));
      expect(await within(panel).findByText('Say why the sample is rejected.')).toBeInTheDocument();
      expect(mockSamplesOf('ord_h_lab_2')[0]?.status).toBe('collected');

      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: /^Reason/ }),
        'Haemolysed',
      );
      await userEvent.click(within(panel).getByRole('button', { name: 'Reject sample' }));
      expect(
        await screen.findByText(
          new RegExp(`^Sample ${String(collected?.accessionId)} rejected. The order is back`),
        ),
      ).toHaveFocus();
      expect(mockSamplesOf('ord_h_lab_2')[0]).toMatchObject({
        status: 'rejected',
        rejectReason: 'haemolysed',
      });

      await chooseStage('To collect');
      expect(
        await within(grid()).findByText(
          `${String(collected?.accessionId)} rejected: Haemolysed. Collect again`,
        ),
      ).toBeInTheDocument();
      await userEvent.click(
        within(grid()).getByRole('button', { name: `Collect sample: ${second()}, Haemoglobin` }),
      );
      const again = await screen.findByRole('region', { name: 'Collect sample: Haemoglobin' });
      expect(
        within(again).getByText(
          `Collect again: sample ${String(collected?.accessionId)} was rejected (Haemolysed).`,
        ),
      ).toBeInTheDocument();
      await userEvent.click(within(again).getByRole('button', { name: 'Mark as collected' }));
      await within(again).findByText(/^Collected as /);
      const samples = mockSamplesOf('ord_h_lab_2');
      expect(samples).toHaveLength(2);
      expect(samples[1]?.accessionId).not.toBe(samples[0]?.accessionId);
      expect(samples[1]?.status).toBe('collected');
    },
  );
});

describe('who reaches the laboratory', () => {
  it('shows a role that only reads the worklist no action that changes it', async () => {
    await post('/lab/orders/ord_h_lab_2/samples');
    setRolePermissions(HOSPITAL, 'admin', [{ permission: 'labSample:read' }]);
    await openWorklist();
    expect(screen.getByRole('link', { name: 'Laboratory' })).toBeInTheDocument();
    expect(within(grid()).queryByRole('button', { name: /^Collect sample/ })).toBeNull();
    expect(within(grid()).queryByRole('button', { name: /^Print label/ })).toBeNull();
    await chooseStage('Collected');
    await within(grid()).findByText(second());
    expect(within(grid()).queryByRole('button', { name: /^Receive/ })).toBeNull();
    expect(within(grid()).queryByRole('button', { name: /^Reject/ })).toBeNull();
    expect(within(grid()).queryByRole('button', { name: /^Print label/ })).toBeNull();
  });

  it('lets a custom role that collects at the bedside collect, and not receive or reject', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'labSample:read' },
      { permission: 'labSample:collect' },
    ]);
    await post('/lab/orders/ord_h_lab_2/samples');
    await openWorklist();
    expect(
      within(grid()).getByRole('button', {
        name: `Collect sample: ${first()}, Complete blood count`,
      }),
    ).toBeInTheDocument();
    await chooseStage('Collected');
    await within(grid()).findByText(second());
    expect(within(grid()).getByRole('button', { name: /^Print label/ })).toBeInTheDocument();
    expect(within(grid()).queryByRole('button', { name: /^Receive/ })).toBeNull();
    expect(within(grid()).queryByRole('button', { name: /^Reject/ })).toBeNull();
  });

  it('is unreachable without labSample:read, and with the laboratory off', async () => {
    revokePermission(HOSPITAL, 'admin', 'labSample:read');
    const app = renderApp({ entry: '/lab' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Laboratory' })).toBeNull();
    app.unmount();

    setTenantFeature(HOSPITAL, 'laboratory', false);
    signIn(USER_IDS.admin, HOSPITAL);
    renderApp({ entry: '/lab' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('keeps each hospital’s worklist and samples to itself', async () => {
    const hospitalSample = await post('/lab/orders/ord_h_lab_2/samples');
    setTenantFeature(CLINIC, 'laboratory', true);
    signIn(USER_IDS.doctor, CLINIC);
    setRolePermissions(CLINIC, 'doctor', [
      { permission: 'labSample:read' },
      { permission: 'labSample:collect' },
      { permission: 'labSample:receive' },
      { permission: 'labSample:reject' },
    ]);
    renderApp({ entry: '/lab' });
    await screen.findByRole('heading', LIST);
    expect(await within(grid()).findByText('No samples to collect.')).toBeInTheDocument();
    expect(within(grid()).queryByText('Complete blood count')).toBeNull();

    // The hospital's order and sample do not exist as far as the clinic is concerned.
    const id = String(hospitalSample?.id);
    expect(await post('/lab/orders/ord_h_lab_1/samples')).toMatchObject({
      error: { code: 'order_not_found' },
    });
    for (const [path, body] of [
      [`/lab/samples/${id}/receive`, { version: 1 }],
      [`/lab/samples/${id}/reject`, { version: 1, reason: 'clotted' }],
      [`/lab/samples/${id}/print`, undefined],
    ] as const) {
      expect(await post(path, body)).toMatchObject({ error: { code: 'sample_not_found' } });
    }
    expect(mockSamplesOf('ord_h_lab_1')).toHaveLength(0);
    expect(mockSamplesOf('ord_h_lab_2')[0]?.status).toBe('collected');
    expect(mockLabelPrints()).toHaveLength(0);
  });
});
