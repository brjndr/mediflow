import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
  grantPermission,
} from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Correction requests (#191, API #556): a queue for the hospital and a tab on the patient. The
// mock's hospital has one pending request and one approved, both on pth_00001 and both by
// someone else; its clinic has one pending.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

describe('the correction queue', () => {
  it('lists the pending requests and has no axe violations', async () => {
    renderApp({ entry: '/records/corrections' });
    const table = await screen.findByRole('table', { name: 'Record corrections' });
    expect(
      await within(table).findByText('Date of birth is 1984-03-12, not 1984-12-03'),
    ).toBeInTheDocument();
    expect(within(table).queryByText('Retitle the scan as a discharge card')).toBeNull();
    await expectNoAxeViolations();
  });

  it('approves a request with a reason and takes it off the pending list', async () => {
    renderApp({ entry: '/records/corrections' });
    const table = await screen.findByRole('table', { name: 'Record corrections' });
    const row = (await within(table).findByText(/Date of birth is/)).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Approve/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText('This field is required.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Reason for the decision/), 'Seen the card');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(within(table).queryByText(/Date of birth is/)).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('Approved: Date of birth is');
  });

  it('offers no decision without correction:decide', async () => {
    revokePermission(HOSPITAL, 'admin', 'correction:decide');
    renderApp({ entry: '/records/corrections' });
    const table = await screen.findByRole('table', { name: 'Record corrections' });
    await within(table).findByText(/Date of birth is/);
    expect(within(table).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('shows another hospital only its own requests', async () => {
    setTenantFeature(CLINIC, 'records', true);
    grantPermission(CLINIC, 'doctor', 'correction:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/records/corrections' });
    const table = await screen.findByRole('table', { name: 'Record corrections' });
    await within(table).findByText('Spelling of the surname');
    expect(within(table).queryByText(/Date of birth is/)).toBeNull();
  });

  it('is unreachable with the module off or without the permission', async () => {
    setTenantFeature(HOSPITAL, 'records', false);
    renderApp({ entry: '/records/corrections' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('table', { name: 'Record corrections' })).toBeNull();
  });

  it('is refused without correction:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'correction:read');
    renderApp({ entry: '/records/corrections' });
    expect(await screen.findByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
  });
});

describe('the Corrections tab of a patient', () => {
  it('lists that patient requests, and a person cannot decide their own', async () => {
    renderApp({ entry: '/patients/pth_00001?tab=corrections' });
    const table = await screen.findByRole('table', { name: 'Corrections' });
    await within(table).findByText('Retitle the scan as a discharge card');
    await userEvent.click(screen.getByRole('button', { name: 'Request a correction' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/What should change/), 'Fix the phone');
    await userEvent.type(within(dialog).getByLabelText(/^Why/), 'Mistyped');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const row = (await within(table).findByText('Fix the phone')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Approve/ }));
    const decide = await screen.findByRole('dialog');
    await userEvent.type(within(decide).getByLabelText(/Reason for the decision/), 'Fine');
    await userEvent.click(within(decide).getByRole('button', { name: 'Approve' }));
    expect(
      await within(decide).findByText(/Someone other than the person who asked/),
    ).toBeInTheDocument();
  });

  it('offers no request without correction:request', async () => {
    revokePermission(HOSPITAL, 'admin', 'correction:request');
    renderApp({ entry: '/patients/pth_00001?tab=corrections' });
    await screen.findByRole('table', { name: 'Corrections' });
    expect(screen.queryByRole('button', { name: 'Request a correction' })).toBeNull();
  });
});
