import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The signed imaging report in the consultation (#1187). The clinical mock's hospital has one
// imaging order, `ord_h_img_1`, a chest X-ray of the encounter `enc_h_1`; it is scheduled,
// performed and reported behind the screen as the radiology staff would.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const ORDER = 'ord_h_img_1';
const SLOT = 15 * 60_000;
const HEADING = { name: 'Imaging reports', level: 2 };

async function send(method: string, path: string, body: unknown) {
  const response = await fetch(new URL(`/api${path}`, window.location.origin), {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Reports the study, as the radiology staff would; signed or left a draft. */
async function report({ sign }: { sign: boolean }) {
  signIn(USER_IDS.admin, HOSPITAL);
  const at = new Date((Math.floor(Date.now() / SLOT) + 1) * SLOT).toISOString();
  const study = await send('POST', `/radiology/orders/${ORDER}/schedule`, { scheduledAt: at });
  await send('POST', `/radiology/orders/${ORDER}/perform`, { version: study.version });
  const draft = await send('PUT', `/radiology/orders/${ORDER}/report`, {
    technique: { type: 'doc', content: [] },
    findings: doc('Lungs clear.'),
    impression: doc('Normal chest.'),
    links: [],
  });
  if (sign)
    await send('POST', `/radiology/orders/${ORDER}/report/sign`, { version: draft.version });
}

describe('the imaging reports of a consultation', () => {
  it('shows the doctor the signed report and its addenda', async () => {
    await report({ sign: true });
    await send('POST', `/radiology/orders/${ORDER}/report/addenda`, {
      body: doc('Small left effusion.'),
      reason: 'correction',
    });
    signIn(USER_IDS.doctor, HOSPITAL);
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', HEADING);
    expect(await screen.findByText('Normal chest.')).toBeInTheDocument();
    expect(screen.getByText('Small left effusion.')).toBeInTheDocument();
    expect(screen.getByText('Chest X-ray', { selector: 'h3' })).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
  });

  it('never shows a draft', async () => {
    await report({ sign: false });
    signIn(USER_IDS.doctor, HOSPITAL);
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', HEADING);
    expect(
      await screen.findByText('No imaging report has been signed for this visit yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Lungs clear.')).toBeNull();
  });

  it('leaves no trace without the permission or with radiology off', async () => {
    await report({ sign: true });
    revokePermission(HOSPITAL, 'doctor', 'imagingReport:read');
    signIn(USER_IDS.doctor, HOSPITAL);
    const first = renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', { name: 'Diagnoses' });
    expect(screen.queryByRole('heading', HEADING)).toBeNull();
    first.unmount();
  });

  it('is off in a hospital that switched radiology off', async () => {
    await report({ sign: true });
    setTenantFeature(HOSPITAL, 'radiology', false);
    signIn(USER_IDS.doctor, HOSPITAL);
    renderApp({ entry: '/encounters/enc_h_1' });
    await screen.findByRole('heading', { name: 'Diagnoses' });
    expect(screen.queryByRole('heading', HEADING)).toBeNull();
  });

  it('shows nothing of the other hospital', async () => {
    await report({ sign: true });
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/encounters/enc_h_1' });
    expect(screen.queryByText('Normal chest.')).toBeNull();
  });
});
