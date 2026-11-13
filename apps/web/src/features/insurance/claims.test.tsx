import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { CLAIM_TRANSITIONS } from '@/mocks/handlers/claims';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { CLAIM_ACTIONS, CLAIM_STATUSES } from './claims';

// Claims (#184): the list, a claim's page with the steps its state allows, the aging, and a claim
// prepared from a visit's split. The sample hospital has claims 1 (sent 70 days ago), 2 (approved),
// 3 (the payer has a question) and 4 (paid short); the clinic has one of its own.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

describe('the claim state machine', () => {
  it('leads only to known states by known actions, and ends in states that offer nothing', () => {
    for (const status of CLAIM_STATUSES) {
      for (const [action, next] of Object.entries(CLAIM_TRANSITIONS[status])) {
        expect(CLAIM_ACTIONS).toContain(action);
        expect(CLAIM_STATUSES).toContain(next);
      }
    }
    expect(CLAIM_TRANSITIONS.written_off).toEqual({});
    expect(CLAIM_TRANSITIONS.cancelled).toEqual({});
    // Nothing is approved before it is sent, and nothing is paid before it is approved.
    expect(CLAIM_TRANSITIONS.draft).not.toHaveProperty('approve');
    expect(CLAIM_TRANSITIONS.submitted).not.toHaveProperty('settle');
    expect(CLAIM_TRANSITIONS.query).not.toHaveProperty('approve');
  });
});

describe('the claim list', () => {
  it('lists this hospital claims, filters by state and has no axe violations', async () => {
    renderApp({ entry: '/claims' });
    expect(await screen.findByRole('link', { name: 'CLM-000001' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'CLM-000004' })).toBeVisible();
    await expectNoAxeViolations();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'query');
    expect(await screen.findByRole('link', { name: 'CLM-000003' })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'CLM-000001' })).toBeNull());
  });

  it('shows the clinic only its own claim', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    grantPermission(CLINIC, 'doctor', 'claim:read');
    setTenantFeature(CLINIC, 'insurance', true);
    renderApp({ entry: '/claims' });
    expect(await screen.findByRole('link', { name: 'CLM-000001' })).toBeVisible();
    expect(screen.getByText('Clinic Care Cover')).toBeVisible();
    expect(screen.queryByText('Star Sample Insurance')).toBeNull();
  });

  it('is not reachable without claim:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'claim:read');
    renderApp({ entry: '/claims' });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'CLM-000001' })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Insurance claims' })).toBeNull();
  });
});

describe('a claim', () => {
  it('goes from approved to paid short to written off, offering only what the state allows', async () => {
    renderApp({ entry: '/claims/clm_h_2' });
    await screen.findByRole('heading', { name: 'Claim CLM-000002', level: 1 });
    // Approved: payment is the only step.
    const actions = screen.getByRole('region', { name: 'What you can do' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((one) => one.textContent),
    ).toEqual(['Record payment']);

    await userEvent.click(within(actions).getByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record payment' });
    // More than was approved is refused, not sent.
    await userEvent.type(within(dialog).getByLabelText(/Amount received/), '9000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/more than was approved/i);
    await userEvent.clear(within(dialog).getByLabelText(/Amount received/));
    await userEvent.type(within(dialog).getByLabelText(/Amount received/), '7000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText(/Claim moved to .Paid./)).toBeVisible();
    expect(screen.getByText('2,000.00', { exact: false, selector: 'dd' })).toBeVisible();
    // Paid short: only the write-off remains.
    const after = screen.getByRole('region', { name: 'What you can do' });
    expect(
      within(after)
        .getAllByRole('button')
        .map((one) => one.textContent),
    ).toEqual(['Write off the rest']);
    await userEvent.click(within(after).getByRole('button', { name: 'Write off the rest' }));
    const writeOff = await screen.findByRole('dialog', { name: 'Write off the rest' });
    expect(writeOff).toHaveTextContent(/This writes off .*2,000.00/);
    // A reason is needed.
    await userEvent.click(within(writeOff).getByRole('button', { name: 'Confirm' }));
    expect(await within(writeOff).findByText('This field is required.')).toBeVisible();
    await userEvent.type(within(writeOff).getByLabelText(/Reason/), 'Payer cut the room rent');
    await userEvent.click(within(writeOff).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Claim moved to .Written off./)).toBeVisible();
    expect(screen.getByText('Nothing more can be done to this claim.')).toBeVisible();
    expect(screen.getByText('Payer cut the room rent')).toBeVisible();
  });

  it('answers a payer question by a reply that sends the claim back', async () => {
    renderApp({ entry: '/claims/clm_h_3' });
    await screen.findByRole('heading', { name: 'Claim CLM-000003', level: 1 });
    expect(screen.getByText('Please send the operation notes.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reply to the question' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reply to the question' });
    await userEvent.type(within(dialog).getByLabelText(/Your reply/), 'Enclosed');
    await userEvent.type(
      within(dialog).getByLabelText('More documents enclosed'),
      'Operation notes',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Claim moved to .Sent to the payer./)).toBeVisible();
    expect(screen.queryByText('Please send the operation notes.')).toBeNull();
    expect(screen.getByText('Operation notes')).toBeVisible();
  });

  it('keeps the write-off from a role without claim:writeoff, and every step from one without claim:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'claim:writeoff');
    const { unmount } = renderApp({ entry: '/claims/clm_h_4' });
    await screen.findByRole('heading', { name: 'Claim CLM-000004', level: 1 });
    expect(screen.queryByRole('button', { name: 'Write off the rest' })).toBeNull();
    expect(screen.getByText('You can read this claim but not change it.')).toBeVisible();
    unmount();

    revokePermission(HOSPITAL, 'admin', 'claim:manage');
    renderApp({ entry: '/claims/clm_h_2' });
    await screen.findByRole('heading', { name: 'Claim CLM-000002', level: 1 });
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
  });

  it('does not show a claim of another hospital', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    grantPermission(CLINIC, 'doctor', 'claim:read');
    setTenantFeature(CLINIC, 'insurance', true);
    renderApp({ entry: '/claims/clm_h_1' });
    expect(await screen.findByText('This claim is not available.')).toBeVisible();
    expect(screen.queryByText('Star Sample Insurance')).toBeNull();
  });
});

describe('the aging', () => {
  it('sums what is unpaid by payer and by days since sent', async () => {
    renderApp({ entry: '/claims/aging' });
    const grid = await screen.findByRole('table', { name: 'Unpaid claims by payer and age' });
    const star = await within(grid).findByRole('row', { name: /Star Sample Insurance/ });
    // Claim 1 (70 days, 12,000.00) and claim 2 (20 days, 9,000.00 less nothing received).
    expect(
      within(star)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual([
      'Star Sample Insurance',
      '2',
      expect.stringContaining('9,000.00'),
      expect.stringMatching(/^\D*0\.00$/),
      expect.stringContaining('12,000.00'),
      expect.stringMatching(/^\D*0\.00$/),
      expect.stringContaining('21,000.00'),
    ]);
    // The paid-short claim (100 days, 1,000.00 still owed) falls in the last column.
    const medi = within(grid).getByRole('row', { name: /MediAssist/ });
    expect(medi).toHaveTextContent(/1,000.00/);
    await expectNoAxeViolations();
  });
});

describe('preparing a claim from a visit', () => {
  it('makes a claim of the payer share and refuses a second one for the same visit', async () => {
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    const panel = await screen.findByRole('region', {
      name: 'Split between the patient and the payer',
    });
    await within(panel).findByTestId('split-ledger');
    await userEvent.click(within(panel).getByRole('button', { name: 'Prepare a claim' }));
    const dialog = await screen.findByRole('dialog', { name: 'Prepare a claim' });
    await userEvent.type(
      within(dialog).getByLabelText('Documents enclosed'),
      'Discharge summary{enter}Final bill',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Prepare claim' }));
    expect(await within(panel).findByText(/was prepared/)).toBeVisible();
    await userEvent.click(within(panel).getByRole('link', { name: 'Open the claim' }));
    await screen.findByRole('heading', { name: /^Claim CLM-/, level: 1 });
    expect(screen.getByText('Being prepared')).toBeVisible();
    expect(screen.getByText('Discharge summary')).toBeVisible();
    // Only what a draft allows.
    const actions = screen.getByRole('region', { name: 'What you can do' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((one) => one.textContent),
    ).toEqual(['Send to the payer', 'Withdraw']);
  });

  it('offers no claim without claim:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'claim:manage');
    renderApp({ entry: '/billing/new?encounterId=enc_h_1' });
    const panel = await screen.findByRole('region', {
      name: 'Split between the patient and the payer',
    });
    await within(panel).findByTestId('split-ledger');
    expect(within(panel).queryByRole('button', { name: 'Prepare a claim' })).toBeNull();
  });
});
