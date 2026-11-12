import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const flagCase = async () => {
  renderApp({ entry: '/emergency/er_2' });
  await userEvent.click(await screen.findByRole('button', { name: 'Mark as medico-legal' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: /Injury and history/ }),
    'Hit by a truck, head injury',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await screen.findByText('Hit by a truck, head injury');
  cleanup();
};

describe('register of medico-legal cases', () => {
  it('is empty until a case is flagged, then lists it with its flag and a link to the case', async () => {
    renderApp({ entry: '/emergency/medico-legal' });
    await screen.findByRole('heading', { level: 1, name: 'Medico-legal cases' });
    expect(await screen.findByText('No case is marked medico-legal.')).toBeInTheDocument();
    cleanup();

    await flagCase();
    renderApp({ entry: '/emergency/medico-legal' });
    const link = await screen.findByRole('link', { name: 'Man in blue jacket' });
    expect(link).toHaveAttribute('href', '/emergency/er_2');
    expect(screen.getByText('1 medico-legal case.')).toBeInTheDocument();
    expect(screen.queryByText('Chest pain')).not.toBeInTheDocument();
    // The record itself is not on this screen.
    expect(screen.queryByText('Hit by a truck, head injury')).not.toBeInTheDocument();
    await expectNoAxeViolations();
  }, 30_000);

  it('is linked from the board only with medicoLegal:read, and unreachable without it', async () => {
    renderApp({ entry: '/emergency' });
    expect(await screen.findByRole('link', { name: 'Medico-legal cases' })).toHaveAttribute(
      'href',
      '/emergency/medico-legal',
    );
    cleanup();

    revokePermission(TENANT_IDS.hospital, 'admin', 'medicoLegal:read');
    renderApp({ entry: '/emergency' });
    await screen.findByRole('heading', { level: 1, name: 'Emergency' });
    expect(screen.queryByRole('link', { name: 'Medico-legal cases' })).not.toBeInTheDocument();
    cleanup();
    renderApp({ entry: '/emergency/medico-legal' });
    expect(screen.queryByRole('heading', { level: 1, name: 'Medico-legal cases' })).toBeNull();
  }, 30_000);
});
