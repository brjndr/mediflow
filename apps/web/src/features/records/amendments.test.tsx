import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// What approved corrections added to a record (#1181, API #1179). The mock's hospital has an
// amendment to a document and one to the visit enc_h_1, both of patient pth_00001; its clinic
// has one of its own patient.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

describe('the Amendments tab of a patient', () => {
  it('shows the text, reason, who asked, who approved and which record, with no axe violations', async () => {
    renderApp({ entry: '/patients/pth_00001?tab=amendments' });
    const document = await screen.findByText('Retitle the scan as a discharge card');
    const card = document.closest('li') as HTMLElement;
    expect(within(card).getByText('Document')).toBeInTheDocument();
    expect(within(card).getByText('Why: Uploaded under the wrong title')).toBeInTheDocument();
    expect(card).toHaveTextContent('Asked by Sample Receptionist, approved by Sample Admin');
    const visit = screen.getByText('The visit was on the 3rd, not the 4th').closest('li');
    expect(within(visit as HTMLElement).getByText('Visit')).toBeInTheDocument();
    expect(visit).toHaveTextContent('Asked by someone');
    await expectNoAxeViolations();
  });

  it('says so when a patient has none', async () => {
    renderApp({ entry: '/patients/pth_00002?tab=amendments' });
    expect(await screen.findByText('No corrections have been added to this record.')).toBeVisible();
  });

  it('has no tab without correction:read, or with the module off', async () => {
    revokePermission(HOSPITAL, 'admin', 'correction:read');
    const first = renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tab', { name: /Overview|Details/i });
    expect(screen.queryByRole('tab', { name: 'Amendments' })).toBeNull();
    first.unmount();
    grantPermission(HOSPITAL, 'admin', 'correction:read');
    setTenantFeature(HOSPITAL, 'records', false);
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tab', { name: /Overview|Details/i });
    expect(screen.queryByRole('tab', { name: 'Amendments' })).toBeNull();
  });

  it('shows another hospital only its own', async () => {
    setTenantFeature(CLINIC, 'records', true);
    grantPermission(CLINIC, 'doctor', 'correction:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/patients/ptc_00001?tab=amendments' });
    await screen.findByText('Clinic-only amendment');
    expect(screen.queryByText('Retitle the scan as a discharge card')).toBeNull();
  });
});

describe('the amendments of a visit', () => {
  it('shows only the visit’s own, under its actions', async () => {
    renderApp({ entry: '/encounters/enc_h_1' });
    const panel = await screen.findByRole('region', { name: 'Amendments to this visit' });
    expect(within(panel).getByText('The visit was on the 3rd, not the 4th')).toBeInTheDocument();
    expect(within(panel).queryByText('Retitle the scan as a discharge card')).toBeNull();
  });

  it('shows nothing for a visit without amendments', async () => {
    renderApp({ entry: '/encounters/enc_h_2' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Amendments to this visit' })).toBeNull();
  });
});
