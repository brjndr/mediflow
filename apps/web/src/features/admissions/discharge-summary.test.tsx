import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { addMockAdmission } from '@/mocks/handlers/admissions-flow';
import { addMockSignedSummary } from '@/mocks/handlers/discharge-summary';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal('print', print);
  addMockAdmission({
    id: 'adm_sum',
    status: 'discharged',
    dischargedAt: '2026-11-10T09:00:00Z',
    version: 2,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const open = async () => {
  renderApp({ entry: '/admissions/adm_sum/summary' });
  await screen.findByRole('heading', { name: 'Discharge summary', level: 1 });
};

const field = (name: string) => screen.findByRole('textbox', { name: new RegExp(`^${name}`) });

describe('writing and signing the discharge summary', () => {
  it('saves a draft, then signs it so it can no longer be changed', async () => {
    await open();
    await userEvent.type(await field('Diagnoses'), 'Pneumonia');
    await userEvent.type(await field('Course in hospital'), 'Recovered on antibiotics');
    await expectNoAxeViolations();

    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign summary' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign summary' }));

    const document_ = await screen.findByRole('article', { name: 'Discharge summary' });
    expect(within(document_).getByText('Pneumonia')).toBeInTheDocument();
    expect(within(document_).getByText(/Signed by/)).toBeInTheDocument();
    // Signed: no draft form is left, only an addendum.
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Add an addendum' })).toBeInTheDocument();
  }, 30_000);

  it('will not sign without the diagnoses and the course', async () => {
    await open();
    await userEvent.type(await field('Diagnoses'), 'Pneumonia');
    await userEvent.click(screen.getByRole('button', { name: 'Sign summary' }));
    expect(await screen.findByText(/Fill in before signing: Course in hospital/)).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  }, 30_000);

  it('starts the course from a template, filled with the stay', async () => {
    await open();
    await screen.findByRole('option', { name: 'Discharge summary' });
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Start the course from a template' }),
      'Discharge summary',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fill the course' }));
    const course = await field('Course in hospital');
    const text = () => (course as HTMLTextAreaElement).value;
    await waitFor(() => expect(text()).toContain('Advice on discharge'));
    expect(text()).not.toContain('{{');
  }, 30_000);

  it('refuses text that is not plain', async () => {
    await open();
    await userEvent.type(await field('Diagnoses'), 'Pneumonia\u0000');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findAllByText(/character that cannot be seen/)).not.toHaveLength(0);
  }, 30_000);
});

describe('a signed discharge summary', () => {
  it('is only added to, by addenda', async () => {
    addMockSignedSummary(HOSPITAL, 'adm_sum', { diagnoses: 'Dengue' });
    await open();
    const document_ = await screen.findByRole('article', { name: 'Discharge summary' });
    expect(within(document_).getByText('Dengue')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Diagnoses/ })).toBeNull();

    await userEvent.type(await screen.findByRole('textbox', { name: /^Addendum/ }), 'Platelets 90');
    await userEvent.click(screen.getByRole('button', { name: 'Add addendum' }));
    expect(await within(document_).findByText('Platelets 90')).toBeInTheDocument();
    expect(within(document_).getByText('Dengue')).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 30_000);

  it('is printed once the print is recorded', async () => {
    addMockSignedSummary(HOSPITAL, 'adm_sum');
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Print summary' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
    expect(sheet).not.toBeNull();
    expect(within(sheet as HTMLElement).getByText(/Signed by/)).toBeInTheDocument();
  }, 30_000);

  it('offers no addendum without dischargeSummary:sign', async () => {
    addMockSignedSummary(HOSPITAL, 'adm_sum');
    revokePermission(HOSPITAL, 'admin', 'dischargeSummary:sign');
    await open();
    await screen.findByRole('article', { name: 'Discharge summary' });
    expect(screen.queryByRole('heading', { name: 'Add an addendum' })).toBeNull();
  }, 30_000);
});

describe('access to the discharge summary', () => {
  it('shows no way in without dischargeSummary:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'dischargeSummary:read');
    addMockAdmission({ id: 'adm_list', status: 'admitted', version: 1 });
    renderApp({ entry: '/admissions' });
    const grid = await screen.findByRole('table', { name: 'Admissions' });
    await within(grid).findAllByRole('button', { name: /Admission details/ });
    expect(within(grid).queryByRole('button', { name: /Summary of stay/ })).toBeNull();
  }, 30_000);

  it('opens from the admissions list', async () => {
    addMockAdmission({ id: 'adm_list', status: 'admitted', version: 1 });
    renderApp({ entry: '/admissions' });
    const grid = await screen.findByRole('table', { name: 'Admissions' });
    const [action] = await within(grid).findAllByRole('button', { name: /Summary of stay/ });
    await userEvent.click(action as HTMLElement);
    expect(
      await screen.findByRole('heading', { name: 'Discharge summary', level: 1 }),
    ).toBeInTheDocument();
  }, 30_000);

  it('is out of reach for a hospital without the admissions module', async () => {
    signIn(USER_IDS.admin, TENANT_IDS.clinic);
    renderApp({ entry: '/admissions/adm_sum/summary' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Discharge summary', level: 1 })).toBeNull(),
    );
  }, 30_000);
});
