import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const grid = () => screen.getByRole('table', { name: 'Transfusion reactions' });

/** A reaction recorded through the mock API, as another person would have. */
const report = async (severity: 'mild' | 'severe', kind = 'febrile') => {
  const response = await fetch('/api/transfusion-reactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      unitId: 'bu_3',
      patientId: 'pth_00001',
      transfusedAt: '2026-11-07T08:00:00.000Z',
      onsetAt: '2026-11-07T08:30:00.000Z',
      kind,
      severity,
      actions: 'Stopped',
    }),
  });
  expect(response.status).toBe(201);
};

const openReactions = async () => {
  renderApp({ entry: '/blood-bank' });
  await screen.findByRole('heading', { name: 'Blood bank', level: 1 });
  await userEvent.click(await screen.findByRole('tab', { name: 'Reactions' }));
};

describe('the reactions list', () => {
  it('lists reactions, filters by severity and opens the trace, with no axe violations', async () => {
    await report('mild');
    await report('severe', 'allergic');
    await openReactions();
    await waitFor(() => expect(within(grid()).getAllByRole('row')).toHaveLength(3));
    expect(screen.getByText('2 reactions')).toBeInTheDocument();
    await expectNoAxeViolations();

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Severity first reported' }),
      'Severe',
    );
    await waitFor(() => expect(within(grid()).getAllByRole('row')).toHaveLength(2));
    expect(within(grid()).getByText('Allergic')).toBeInTheDocument();

    await userEvent.click(within(grid()).getByRole('button', { name: /Open trace/ }));
    expect(await screen.findByRole('dialog', { name: 'Trace of unit BU-0003' })).toBeVisible();
  }, 30_000);

  it('says so when nothing was reported', async () => {
    await openReactions();
    expect(await screen.findByText('No reaction has been reported.')).toBeInTheDocument();
  });

  it('has no tab without transfusionReaction:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'transfusionReaction:read');
    renderApp({ entry: '/blood-bank' });
    await screen.findByRole('heading', { name: 'Blood bank', level: 1 });
    expect(screen.queryByRole('tab', { name: 'Reactions' })).not.toBeInTheDocument();
  });

  it('is not reachable at the clinic, whose blood bank is off', async () => {
    setTenantFeature(TENANT_IDS.clinic, 'bloodbank', false);
    signIn(USER_IDS.admin, TENANT_IDS.clinic);
    renderApp({ entry: '/blood-bank' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });
});
