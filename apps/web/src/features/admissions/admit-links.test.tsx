import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { renderApp } from '@/test/render';

const PATIENT = 'pth_00001';
const LINK = { name: 'Admit to hospital' };
const SLOW = { timeout: 10_000 };

describe('"Admit to hospital" from the patient screen (#576)', () => {
  it('opens the admit form with the patient filled', async () => {
    renderApp({ entry: `/patients/${PATIENT}` });
    // The patient page loads first, then the slot contribution (a lazy chunk); wait for both (#842).
    await screen.findByRole('link', { name: 'Edit' }, SLOW);
    await userEvent.click(await screen.findByRole('link', LINK, SLOW));
    await screen.findByRole('heading', { name: 'Admit a patient', level: 1 });
    expect(await screen.findByRole('button', { name: 'Change patient' })).toBeInTheDocument();
  });

  it('offers nothing without admission:create', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'admission:create');
    renderApp({ entry: `/patients/${PATIENT}` });
    await screen.findByRole('link', { name: 'Edit' });
    expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
  });

  it('offers nothing with admissions switched off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'admissions', false);
    renderApp({ entry: `/patients/${PATIENT}` });
    await screen.findByRole('link', { name: 'Edit' });
    expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
  });
});
