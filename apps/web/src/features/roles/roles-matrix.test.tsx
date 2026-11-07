import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { sessionKey, type Session } from '@/app/session';
import { grantPermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The whole catalog is drawn as checkboxes: slow on a small machine.
vi.setConfig({ testTimeout: 30_000 });

const openMatrix = async (roleId = 'doctor', name = 'Doctor') => {
  const app = renderApp({ entry: `/roles/${roleId}` });
  await screen.findByRole('heading', { name: `Permissions of ${name}`, level: 1 });
  return app;
};
const box = (permission: string) =>
  screen.getByRole('checkbox', { name: new RegExp(`${permission.replace(/[.:]/g, '\\$&')}$`) });
const save = () => screen.getByRole('button', { name: 'Save permissions' });
const status = () => screen.getByRole('status');
const roleOf = (roleId: string) =>
  api.GET('/roles/{roleId}', { params: { path: { roleId } } }).then((result) => result.data);

describe('the permission matrix', () => {
  it('groups permissions by module and shows what the role holds', async () => {
    await openMatrix();

    expect(screen.getAllByRole('group', { name: /^Patient/ }).length).toBeGreaterThan(0);
    expect(box('patient:read')).toBeChecked();
    expect(box('patient:delete')).not.toBeChecked();
    expect(status()).toHaveTextContent('No changes.');
  });

  it('changes what a role may do with the keyboard, and says it was saved', async () => {
    await openMatrix();

    box('patient:delete').focus();
    await userEvent.keyboard(' ');
    expect(box('patient:delete')).toBeChecked();
    expect(status()).toHaveTextContent('1 unsaved change.');

    await userEvent.click(save());
    await waitFor(() => expect(status()).toHaveTextContent('Saved the permissions of Doctor.'));
    const role = await roleOf('doctor');
    expect(role?.permissions.map((g) => g.permission)).toContain('patient:delete');
  });

  it('offers a scope only where the catalog allows one', async () => {
    await openMatrix();

    const scope = screen.getByRole('combobox', { name: 'Scope of appointment:read' });
    expect(screen.queryByRole('combobox', { name: 'Scope of patient:read' })).toBeNull();

    await userEvent.selectOptions(scope, 'own');
    await userEvent.click(save());
    await waitFor(() => expect(status()).toHaveTextContent('Saved'));
    const role = await roleOf('doctor');
    expect(role?.permissions.find((g) => g.permission === 'appointment:read')?.scope).toBe('own');
  });

  it('keeps the caller from removing role management from their own role', async () => {
    await openMatrix('admin', 'Admin');

    const manage = box('role:manage');
    expect(manage).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(manage);
    expect(manage).toBeChecked();
    expect(manage).toHaveAccessibleDescription(/cannot take away your own ability/);
  });

  it('shows the refusal of a change that would leave nobody to manage the hospital', async () => {
    server.use(
      http.put('*/api/roles/:roleId', () =>
        HttpResponse.json(
          { error: { code: 'last_admin', message: 'Nobody left', requestId: 'r' } },
          { status: 409 },
        ),
      ),
    );
    await openMatrix();
    await userEvent.click(box('patient:delete'));
    await userEvent.click(save());

    expect(await screen.findByRole('alert')).toHaveTextContent('Nobody would be left to manage');
    // What was chosen stays, so it can be changed and sent again.
    expect(box('patient:delete')).toBeChecked();
  });

  it('cannot give what the caller does not hold, nor change a role above the caller', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'role:read');
    grantPermission(TENANT_IDS.hospital, 'doctor', 'role:manage');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    // A role of the doctor's own size: patient:read only.
    await api.POST('/roles', {
      body: { name: 'Small', permissions: [{ permission: 'patient:read' }] },
      params: { header: { 'idempotency-key': 'small-role-key' } },
    });
    const { unmount } = await openMatrix('small', 'Small');
    expect(box('stock:adjust')).toHaveAttribute('aria-disabled', 'true');
    expect(box('patient:update')).not.toHaveAttribute('aria-disabled');
    unmount();

    // The admin role holds more than a doctor does.
    await openMatrix('admin', 'Admin');
    expect(await screen.findByText(/may do more than yours/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save permissions' })).toBeNull();
  });

  it('shows a role without role:manage but offers no way to change it', async () => {
    grantPermission(TENANT_IDS.hospital, 'doctor', 'role:read');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    await openMatrix();

    expect(screen.getByText(/not change it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save permissions' })).toBeNull();
  });

  it('keeps own changes when someone else changed the role meanwhile', async () => {
    await openMatrix();
    await userEvent.click(box('patient:delete'));
    await userEvent.click(box('patient:create'));
    // Someone else removes patient:update and also grants patient:delete.
    const current = await roleOf('doctor');
    await api.PUT('/roles/{roleId}', {
      params: { path: { roleId: 'doctor' } },
      body: {
        permissions: [
          ...(current?.permissions ?? []).filter((g) => g.permission !== 'patient:update'),
          { permission: 'patient:delete', scope: 'all' },
        ],
      },
    });

    await userEvent.click(save());
    await waitFor(() => expect(status()).toHaveTextContent(/Someone else changed this role/));
    // Their change is taken, mine kept, and where both changed the same one it is said.
    expect(box('patient:update')).not.toBeChecked();
    expect(box('patient:delete')).toBeChecked();
    expect(box('patient:create')).toBeChecked();
    expect(box('patient:delete')).toHaveAccessibleDescription(/Saved by someone else: All records/);

    await userEvent.click(save());
    await waitFor(() => expect(status()).toHaveTextContent('Saved the permissions of Doctor.'));
  });

  it('refreshes the policy of the caller at once when their own role was changed', async () => {
    const { queryClient } = await openMatrix('admin', 'Admin');
    const permissions = () =>
      queryClient
        .getQueryData<Session | null>(sessionKey)
        ?.policy?.permissions.map((g) => g.permission) ?? [];
    expect(permissions()).toContain('patient:delete');

    await userEvent.click(box('patient:delete'));
    await userEvent.click(save());

    // No reload and no wait for the timer.
    await waitFor(() => expect(permissions()).not.toContain('patient:delete'));
  });

  it('has no accessibility violations', async () => {
    const { container } = await openMatrix();
    await expectNoAxeViolations(container);
  });

  it('says so for a role that does not exist', async () => {
    renderApp({ entry: '/roles/nobody' });
    expect(await screen.findByRole('heading', { name: 'Role not found' })).toBeInTheDocument();
  });
});

describe('the role list', () => {
  it('leads to the matrix of a role', async () => {
    renderApp({ entry: '/roles' });
    await screen.findByText('Doctor');
    await userEvent.click(
      within(screen.getByRole('row', { name: /^Doctor/ })).getByRole('button', {
        name: /^Permissions/,
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Permissions of Doctor' }),
    ).toBeInTheDocument();
  });
});
