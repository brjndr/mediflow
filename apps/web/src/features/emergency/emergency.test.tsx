import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { isOverdue, minutesSince, TARGET_MINUTES } from './schemas';
import type { EmergencyCase } from './types';

const HEADING = { name: 'Emergency', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const grid = () => screen.getByRole('table', { name: 'Emergency board' });
const rowOf = (text: string) =>
  within(grid())
    .getAllByRole('row')
    .find((row) =>
      within(row)
        .queryAllByRole('cell')
        .some((cell) => cell.textContent === text),
    ) as HTMLElement;

const open = async () => {
  renderApp({ entry: '/emergency' });
  await screen.findByRole('heading', HEADING);
  await waitFor(() => expect(rowOf('ER-0002')).toBeDefined());
};

describe('waiting targets', () => {
  const base: EmergencyCase = {
    id: 'x',
    tenantId: 't',
    tempId: 'ER-1',
    sex: 'unknown',
    complaint: 'c',
    arrivalMode: 'walk_in',
    status: 'waiting',
    arrivedAt: '2026-11-09T10:00:00.000Z',
    medicoLegal: false,
    version: 1,
  };
  const at = (minutes: number) => Date.parse(base.arrivedAt) + minutes * 60_000;

  it('is overdue only past the target of its category, while waiting', () => {
    const urgent = { ...base, category: 2 };
    expect(isOverdue(urgent, at(TARGET_MINUTES[2]))).toBe(false);
    expect(isOverdue(urgent, at(TARGET_MINUTES[2] + 1))).toBe(true);
    expect(isOverdue({ ...urgent, status: 'in_treatment' }, at(500))).toBe(false);
    expect(isOverdue(base, at(500))).toBe(false);
  });

  it('counts whole minutes and never goes negative', () => {
    expect(minutesSince(base.arrivedAt, at(5) + 59_000)).toBe(5);
    expect(minutesSince(base.arrivedAt, at(-3))).toBe(0);
  });
});

describe('emergency board', () => {
  it('lists the department, untriaged first, then by urgency, with the overdue marked', async () => {
    await open();
    const order = within(grid())
      .getAllByRole('row')
      .map((row) => within(row).queryAllByRole('cell')[1]?.textContent)
      .filter(Boolean);
    expect(order).toEqual(['ER-0002', 'ER-0001', 'ER-0004', 'ER-0003']);
    const urgent = rowOf('ER-0001');
    expect(within(urgent).getByText('2 Very urgent')).toBeInTheDocument();
    expect(within(urgent).getByText(/Overdue \(target 10 min\)/)).toBeInTheDocument();
    expect(within(rowOf('ER-0002')).getByText('Not triaged')).toBeInTheDocument();
    expect(within(rowOf('ER-0002')).getByText('Man in blue jacket')).toBeInTheDocument();
    expect(await screen.findByText(/1 is past the waiting target/)).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 20_000);

  it('is reached from the navigation', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('link', { name: 'Emergency' }));
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });

  it('filters to those in treatment', async () => {
    await open();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'in_treatment');
    await waitFor(() => expect(within(grid()).queryByText('ER-0002')).not.toBeInTheDocument());
    expect(within(grid()).getByText('ER-0004')).toBeInTheDocument();
  });

  it('registers an unidentified arrival with a complaint only', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Register an arrival' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Register' }));
    expect(await screen.findAllByText(/required/i)).not.toHaveLength(0);

    await userEvent.type(screen.getByRole('textbox', { name: /Complaint/ }), 'Fall from a ladder');
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Registered as ER-0005.'),
    );
    await waitFor(() => expect(rowOf('ER-0005')).toBeDefined());
    expect(within(rowOf('ER-0005')).getByText('Unidentified patient')).toBeInTheDocument();
  }, 20_000);

  it('registers a patient on record, triaged at once', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Register an arrival' }));
    // The dialog ignores clicks (pointer-events none) while it animates in: retry until it takes one.
    await waitFor(async () => {
      await userEvent.click(await screen.findByRole('button', { name: 'Patient on record' }));
    });
    await userEvent.type(screen.getByRole('textbox', { name: /Complaint/ }), 'High fever');
    await waitFor(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    });
    expect(
      await screen.findByText('Choose the patient, or register them as unidentified.'),
    ).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /Triage category/ }),
      '3 Urgent',
    );
    await userEvent.type(screen.getByRole('combobox', { name: 'Patient' }), 'MRN-PTH-00001');
    await userEvent.click(
      await screen.findByRole('option', { name: /MRN-PTH-00001/ }, { timeout: 5000 }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Registered as ER-0005.'),
    );
    await waitFor(() => expect(within(rowOf('ER-0005')).getByText('3 Urgent')).toBeInTheDocument());
  }, 30_000);

  it('sets a triage category and moves the patient up the board', async () => {
    await open();
    await userEvent.click(within(rowOf('ER-0002')).getByRole('button', { name: /Set category/ }));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: /Category/ }), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Save category' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('ER-0002 is category 1.'),
    );
    await waitFor(() =>
      expect(within(rowOf('ER-0002')).getByText('1 Immediate')).toBeInTheDocument(),
    );
  }, 20_000);

  it('links an unidentified patient to a record, and not one already linked', async () => {
    await open();
    expect(
      within(rowOf('ER-0001')).getByRole('button', { name: /Identify patient/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(
      within(rowOf('ER-0002')).getByRole('button', { name: /Identify patient/ }),
    );
    await userEvent.type(await screen.findByRole('combobox', { name: /Patient/ }), 'MRN-PTH-00001');
    await userEvent.click(
      await screen.findByRole('option', { name: /MRN-PTH-00001/ }, { timeout: 5000 }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Link to record' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('ER-0002 is linked to the patient'),
    );
    await waitFor(() =>
      expect(
        within(rowOf('ER-0002')).getByRole('button', { name: /Identify patient/ }),
      ).toHaveAttribute('aria-disabled', 'true'),
    );
  }, 30_000);

  it('says a case was changed by someone else first', async () => {
    await open();
    server.use(
      http.post('*/api/emergency/cases/:caseId/triage', () =>
        HttpResponse.json(
          { error: { code: 'version_conflict', message: 'It has changed', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(within(rowOf('ER-0002')).getByRole('button', { name: /Set category/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save category' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this first');
  });
});

describe('access to the emergency board', () => {
  it('is closed without emergency:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'emergency:read');
    renderApp({ entry: '/emergency' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Emergency' })).not.toBeInTheDocument();
  });

  it('offers no registration or triage without the permissions', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'emergency:register');
    revokePermission(TENANT_IDS.hospital, 'admin', 'emergency:triage');
    await open();
    expect(screen.queryByRole('button', { name: 'Register an arrival' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set category/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Identify patient/ })).not.toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'emergency', false);
    renderApp({ entry: '/emergency' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Emergency' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('has no emergency board at the clinic', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'emergency:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await open();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await screen.findByRole('heading', { name: 'Hospital management system' });
    expect(screen.queryByRole('link', { name: 'Emergency' })).not.toBeInTheDocument();
  });
});
