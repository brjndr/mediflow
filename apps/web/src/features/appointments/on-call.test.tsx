import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Book an appointment', level: 1 };

describe('on call on the booking screen', () => {
  it('shows who is on call now', async () => {
    renderApp({ entry: '/appointments/new' });
    await screen.findByRole('heading', HEADING);
    expect(await screen.findByRole('heading', { name: 'On call now' })).toBeInTheDocument();
  });

  it('shows nothing without roster:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'roster:read');
    renderApp({ entry: '/appointments/new' });
    await screen.findByRole('heading', HEADING);
    await screen.findByRole('combobox', { name: /^Doctor/ });
    expect(screen.queryByRole('heading', { name: 'On call now' })).not.toBeInTheDocument();
  });

  it('shows nothing with the roster switched off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'roster', false);
    renderApp({ entry: '/appointments/new' });
    await screen.findByRole('heading', HEADING);
    await screen.findByRole('combobox', { name: /^Doctor/ });
    expect(screen.queryByRole('heading', { name: 'On call now' })).not.toBeInTheDocument();
  });
});
