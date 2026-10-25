import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockSamplesOf } from '@/mocks/handlers/lab';
import { mockPatient } from '@/mocks/handlers/patients';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Outsourced tests (#94): a received sample sent to a partner laboratory, waiting "With partner
// lab" until its report is back, then resulted as any other. `ord_h_lab_2` is the hospital's
// haemoglobin of pth_00002 (lab.test.tsx says more of the mock).

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const LIST = { name: 'Laboratory worklist', level: 1 };

const patient = () => mockPatient(HOSPITAL, 'pth_00002')?.name ?? '';
const grid = () => screen.getByRole('table', { name: LIST.name });
const chooseStage = (stage: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), stage);

/** Calls the mock as another member of staff would, behind the open screen. */
async function post(path: string, body?: unknown) {
  const response = await fetch(new URL(`/api${path}`, window.location.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** The haemoglobin's sample collected and received. */
async function receivedSample() {
  const collected = await post('/lab/orders/ord_h_lab_2/samples');
  return post(`/lab/samples/${String(collected.id)}/receive`, { version: collected.version });
}

async function openStage(stage: string) {
  renderApp({ entry: '/lab' });
  await screen.findByRole('heading', LIST);
  await chooseStage(stage);
  await within(grid()).findByText(patient());
}

describe('outsourced tests', () => {
  it('sends a received sample to a partner, takes its report back, then enters results', async () => {
    const sample = await receivedSample();
    await openStage('Received');
    await userEvent.click(
      within(grid()).getByRole('button', {
        name: `Send to partner lab: ${patient()}, Haemoglobin`,
      }),
    );
    const panel = await screen.findByRole('region', {
      name: `Send sample ${String(sample.accessionId)} to a partner laboratory`,
    });
    await expectNoAxeViolations(panel);
    await userEvent.type(within(panel).getByLabelText(/Partner laboratory/), ' City  Lab ');
    await userEvent.type(within(panel).getByLabelText(/Partner’s reference/), 'CL-12');
    await userEvent.click(within(panel).getByRole('button', { name: 'Mark as sent' }));
    expect(
      await screen.findByText(
        new RegExp(`^Sample ${String(sample.accessionId)} sent to City Lab\\.`),
      ),
    ).toHaveFocus();
    expect(mockSamplesOf('ord_h_lab_2')[0]).toMatchObject({
      status: 'received',
      partnerLab: 'City Lab',
      partnerRef: 'CL-12',
    });
    await waitFor(() => expect(within(grid()).queryByText(patient())).toBeNull());

    await chooseStage('With partner lab');
    await within(grid()).findByText(new RegExp(`sent to City Lab`));
    expect(within(grid()).queryByRole('button', { name: /^Results/ })).toBeNull();
    await userEvent.click(
      within(grid()).getByRole('button', { name: `Report received: ${patient()}, Haemoglobin` }),
    );
    expect(await screen.findByText(/^Partner report for sample .* received/)).toBeInTheDocument();
    expect(mockSamplesOf('ord_h_lab_2')[0]?.returnedAt).toBeDefined();

    await chooseStage('Received');
    await within(grid()).findByText(/report back from City Lab/);
    expect(
      within(grid()).getByRole('button', {
        name: `Send to partner lab: ${patient()}, Haemoglobin`,
      }),
    ).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(
      within(grid()).getByRole('button', { name: `Results: ${patient()}, Haemoglobin` }),
    );
    expect(await screen.findByRole('heading', { name: 'Enter results' })).toBeInTheDocument();
    expect(screen.getByText('City Lab (ref. CL-12)')).toBeInTheDocument();
  });

  it('asks for the partner, and enters no results while the sample is with it', async () => {
    const sample = await receivedSample();
    await openStage('Received');
    await userEvent.click(
      within(grid()).getByRole('button', {
        name: `Send to partner lab: ${patient()}, Haemoglobin`,
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as sent' }));
    expect(await screen.findByText('Name the partner laboratory.')).toBeInTheDocument();
    expect(mockSamplesOf('ord_h_lab_2')[0]?.sentOutAt).toBeUndefined();

    await post(`/lab/samples/${String(sample.id)}/send-out`, {
      version: sample.version,
      partnerLab: 'City Lab',
    });
    renderApp({ entry: '/lab/orders/ord_h_lab_2' });
    expect(
      await screen.findByText(/is with City Lab\. Results are entered once its report is back/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Enter results' })).toBeNull();
    expect(
      await post(`/lab/samples/${String(sample.id)}/results`, {
        results: [{ labTestId: 'lab_h_hb', value: '12' }],
      }),
    ).toMatchObject({ error: { code: 'with_partner' } });
  });

  it('offers neither action without labSample:outsource', async () => {
    const sample = await receivedSample();
    await post(`/lab/samples/${String(sample.id)}/send-out`, {
      version: sample.version,
      partnerLab: 'City Lab',
    });
    revokePermission(HOSPITAL, 'admin', 'labSample:outsource');
    await openStage('With partner lab');
    expect(within(grid()).queryByRole('button', { name: /^Report received/ })).toBeNull();
    await chooseStage('Received');
    expect(within(grid()).queryByRole('button', { name: /^Send to partner lab/ })).toBeNull();
  });

  it('keeps a hospital’s samples from another hospital', async () => {
    const sample = await receivedSample();
    setTenantFeature(CLINIC, 'laboratory', true);
    signIn(USER_IDS.doctor, CLINIC);
    setRolePermissions(CLINIC, 'doctor', [
      { permission: 'labSample:read' },
      { permission: 'labSample:outsource' },
    ]);
    const id = String(sample.id);
    expect(
      await post(`/lab/samples/${id}/send-out`, { version: sample.version, partnerLab: 'X' }),
    ).toMatchObject({ error: { code: 'sample_not_found' } });
    expect(
      await post(`/lab/samples/${id}/partner-report`, { version: sample.version }),
    ).toMatchObject({ error: { code: 'sample_not_found' } });
    expect(mockSamplesOf('ord_h_lab_2')[0]?.sentOutAt).toBeUndefined();
  });
});
