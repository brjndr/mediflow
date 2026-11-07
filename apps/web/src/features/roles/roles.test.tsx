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
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { roleKeys } from './hooks/use-roles';

const HEADING = { name: 'Roles', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const openList = async () => {
  // Desktop width, so the screen is mounted (setup.ts fixes matchMedia at desktop).
  const app = renderApp({ entry: '/roles' });
  await screen.findByRole('heading', HEADING);
  await screen.findByText('Doctor');
  return app;
};
const row = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}`) });
const button = (name: string | RegExp) => screen.getByRole('button', { name });

async function addRole(name: string) {
  await userEvent.click(button('Add role'));
  await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), name);
  await userEvent.click(button('Save role'));
}

describe('the role list', () => {
  it('lists built-in roles first and marks which are custom', async () => {
    await openList();

    expect(screen.getByRole('status')).toHaveTextContent('4 roles');
    expect(within(row('Admin')).getByText('Built-in')).toBeInTheDocument();
    expect(screen.queryByText('Billing clerk')).not.toBeInTheDocument();
  });

  it('protects built-in roles: they cannot be renamed or deleted', async () => {
    await openList();

    const admin = row('Admin');
    expect(within(admin).getByRole('button', { name: /^Rename/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(admin).getByRole('button', { name: /^Delete/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = await openList();
    await expectNoAxeViolations(container);
  });
});

describe('custom roles', () => {
  it('adds one, which then shows in the invite form', async () => {
    const { router } = await openList();

    await addRole('Nurse in charge');
    expect(await screen.findByText('Added Nurse in charge.')).toBeInTheDocument();
    expect(within(row('Nurse in charge')).getByText('Custom')).toBeInTheDocument();

    await router.navigate('/staff/invite');
    const roles = await screen.findByRole('combobox', { name: /^Role/ });
    await waitFor(() =>
      expect(within(roles).getByRole('option', { name: 'Nurse in charge' })).toBeInTheDocument(),
    );
  });

  it('refuses a name that is taken, and says so in the form', async () => {
    await openList();
    await addRole('Doctor');

    expect(await screen.findByText('A role with that name already exists.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeInTheDocument();
  });

  it('asks for a name', async () => {
    await openList();
    await userEvent.click(button('Add role'));
    await userEvent.click(button('Save role'));

    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
  });

  it('renames a custom role', async () => {
    await openList();
    await addRole('Ward clerk');
    await screen.findByText('Added Ward clerk.');

    await userEvent.click(within(row('Ward clerk')).getByRole('button', { name: /^Rename/ }));
    const name = screen.getByRole('textbox', { name: /^Name/ });
    await userEvent.clear(name);
    await userEvent.type(name, 'Ward secretary');
    await userEvent.click(button('Save role'));

    expect(await screen.findByText('Renamed to Ward secretary.')).toBeInTheDocument();
    expect(screen.queryByText('Ward clerk')).not.toBeInTheDocument();
  });

  it('deletes one after a confirmation', async () => {
    await openList();
    await addRole('Ward clerk');
    await screen.findByText('Added Ward clerk.');

    await userEvent.click(within(row('Ward clerk')).getByRole('button', { name: /^Delete/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Ward clerk?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete role' }));

    expect(await screen.findByText('Deleted Ward clerk.')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /^Ward clerk/ })).not.toBeInTheDocument();
  });

  it('keeps the role when the confirmation is cancelled', async () => {
    await openList();
    await addRole('Ward clerk');
    await screen.findByText('Added Ward clerk.');

    await userEvent.click(within(row('Ward clerk')).getByRole('button', { name: /^Delete/ }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep role' }));

    expect(row('Ward clerk')).toBeInTheDocument();
  });

  it('is told by the server that a built-in role cannot go', async () => {
    await openList();

    await expect(
      api.DELETE('/roles/{roleId}', { params: { path: { roleId: 'admin' } } }),
    ).rejects.toMatchObject({ serverCode: 'built_in_role' });
    await expect(
      api.PUT('/roles/{roleId}', { params: { path: { roleId: 'doctor' } }, body: { name: 'MD' } }),
    ).rejects.toMatchObject({ serverCode: 'built_in_role' });
  });
});

describe('access', () => {
  it('lets someone who may only read see the list, with nothing to change it', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'role:manage');
    await openList();

    expect(screen.queryByRole('button', { name: 'Add role' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Rename|Delete)/ })).not.toBeInTheDocument();
  });

  it('has no screen and no navigation entry without the permission', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ entry: '/roles' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument();
  });

  it('serves a role to a custom role that holds the permission', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'role:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openList();

    expect(screen.queryByRole('button', { name: 'Add role' })).not.toBeInTheDocument();
  });

  it('does not exist for a hospital that has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'roles', false);
    renderApp({ entry: '/roles' });

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('shows each hospital its own roles, and caches them apart', async () => {
    grantPermission(TENANT_IDS.clinic, 'receptionist', 'role:read');
    signIn(USER_IDS.receptionist, TENANT_IDS.clinic);
    const { queryClient } = renderApp({ entry: '/roles' });

    expect(await screen.findByText('Billing clerk')).toBeInTheDocument();
    expect(screen.queryByText('Store keeper')).not.toBeInTheDocument();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: roleKeys.all(TENANT_IDS.clinic) }),
    ).not.toEqual([]);
    expect(
      queryClient.getQueryCache().findAll({ queryKey: roleKeys.all(TENANT_IDS.hospital) }),
    ).toEqual([]);
  });
});
