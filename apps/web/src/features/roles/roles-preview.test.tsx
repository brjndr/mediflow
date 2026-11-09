import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { box } from './matrix-test-utils';

vi.setConfig({ testTimeout: 30_000 });

const openMatrix = async () => {
  const app = renderApp({ entry: '/roles/doctor' });
  await screen.findByRole('heading', { name: 'Permissions of Doctor', level: 1 });
  return app;
};
const menu = () => within(screen.getByRole('list', { name: 'Menu' }));

describe('the view-as-role preview', () => {
  it('shows what the role gets, by the same registry rules as the real menu', async () => {
    await openMatrix();

    expect(menu().getByText('Patients')).toBeInTheDocument();
    // The doctor role has no role management, so there is no Roles entry in its menu.
    expect(menu().queryByText('Roles')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Pages' })).getAllByRole('listitem').length,
    ).toBeGreaterThan(0);
  });

  it('follows the unsaved matrix, leaves the real menu alone and sends nothing', async () => {
    await openMatrix();
    const realNav = screen.getAllByRole('navigation')[0] as HTMLElement;
    const before = realNav.textContent;
    const writes = vi.fn();
    server.use(
      http.put('*/api/roles/:roleId', () => {
        writes();
        return HttpResponse.error();
      }),
    );

    box('patient:read').focus();
    await userEvent.keyboard(' ');
    expect(box('patient:read')).not.toBeChecked();
    expect(menu().queryByText('Patients')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'As saved' }));
    expect(menu().getByText('Patients')).toBeInTheDocument();

    expect(realNav.textContent).toBe(before);
    expect(writes).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = await openMatrix();
    await expectNoAxeViolations(container);
  });
});
