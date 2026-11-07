import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { grantPermission, revokePermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { apiFetch } from '@/shared/api';
import { renderApp } from '@/test/render';

vi.setConfig({ testTimeout: 30_000 });

const DENIED_URL = 'http://localhost:3000/api/denied';
const NO_ACCESS = { name: 'You do not have access to this page' };
const navRoles = () => screen.queryAllByRole('link', { name: 'Roles' });
const refusal = (status: number, code: string) =>
  HttpResponse.json({ error: { code, message: 'No', requestId: 'r' } }, { status });

/** Any request the server refuses with 403: the app then reads the policy again. */
async function refused() {
  server.use(http.get(DENIED_URL, () => new HttpResponse(null, { status: 403 })));
  await apiFetch(DENIED_URL).catch(() => undefined);
}

/** A doctor who was given role access by an administrator, as the role matrix would do. */
function doctorWithRoleAccess(...permissions: string[]) {
  for (const permission of permissions) grantPermission(TENANT_IDS.hospital, 'doctor', permission);
  signIn(USER_IDS.doctor, TENANT_IDS.hospital);
}

describe('an edit to a role reaches a session that is already open', () => {
  it('takes an action away, then the screen and its navigation, with no reload', async () => {
    doctorWithRoleAccess('role:read', 'role:manage');
    renderApp({ entry: '/roles' });
    const heading = await screen.findByRole('heading', { name: 'Roles', level: 1 });
    const add = await screen.findByRole('button', { name: 'Add role' });
    expect(add).toBeInTheDocument();
    expect(navRoles().length).toBeGreaterThan(0);

    // Another administrator removes role:manage from the doctor role on the server. Nothing in
    // this tab knows yet; the first thing the server refuses brings the policy up to date.
    revokePermission(TENANT_IDS.hospital, 'doctor', 'role:manage');
    server.use(http.post('*/api/roles', () => refusal(403, 'forbidden')));
    await userEvent.click(add);
    await userEvent.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Ward clerk');
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add role' })).toBeNull());
    // The list is still there: reading was not taken away, and the page was not reloaded.
    expect(screen.getByRole('heading', { name: 'Roles', level: 1 })).toBe(heading);
    expect(navRoles().length).toBeGreaterThan(0);
  });

  it('takes the screen and its menu entry when the read permission goes', async () => {
    doctorWithRoleAccess('role:read');
    renderApp({ entry: '/roles' });
    await screen.findByRole('heading', { name: 'Roles', level: 1 });
    expect(navRoles().length).toBeGreaterThan(0);

    revokePermission(TENANT_IDS.hospital, 'doctor', 'role:read');
    await refused();

    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(navRoles()).toHaveLength(0);
  });

  it('gives a screen and a menu entry that were not there before', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { router } = renderApp({ entry: '/roles' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(navRoles()).toHaveLength(0);

    // The administrator grants role:read; the next refusal brings the policy up to date.
    grantPermission(TENANT_IDS.hospital, 'doctor', 'role:read');
    await refused();

    await waitFor(() => expect(navRoles().length).toBeGreaterThan(0));
    await router.navigate('/roles');
    expect(await screen.findByRole('heading', { name: 'Roles', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', NO_ACCESS)).toBeNull();
  });
});

describe('the lockout safeguards, as the matrix shows them', () => {
  const openMatrix = async (roleId: string, name: string) => {
    renderApp({ entry: `/roles/${roleId}` });
    await screen.findByRole('heading', { name: `Permissions of ${name}`, level: 1 });
  };
  const box = (permission: string) =>
    screen.getByRole('checkbox', { name: new RegExp(`${permission.replace(/[.:]/g, '\\$&')}$`) });

  it.each([
    ['cannot_remove_own_access', 409, 'You cannot take away your own ability to manage roles.'],
    ['role_not_allowed', 403, 'You cannot change a role that may do more than yours.'],
    ['last_admin', 409, 'Nobody would be left to manage roles or staff.'],
  ])('shows the server refusal %s and keeps the edit', async (code, status, text) => {
    server.use(http.put('*/api/roles/:roleId', () => refusal(status, code)));
    await openMatrix('doctor', 'Doctor');
    await userEvent.click(box('patient:delete'));
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(box('patient:delete')).toBeChecked();
  });

  it('does not offer to take role:manage from the caller own role, and sends nothing', async () => {
    let puts = 0;
    server.use(
      http.put('*/api/roles/:roleId', () => {
        puts++;
        return undefined;
      }),
    );
    await openMatrix('admin', 'Admin');

    const manage = box('role:manage');
    expect(manage).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(manage);
    expect(manage).toBeChecked();
    expect(puts).toBe(0);
  });
});

describe('the lockout safeguards, as the role list shows them', () => {
  it('says why a role above the caller cannot be removed', async () => {
    server.use(http.delete('*/api/roles/:roleId', () => refusal(403, 'role_not_allowed')));
    renderApp({ entry: '/roles' });
    await screen.findByRole('heading', { name: 'Roles', level: 1 });
    await screen.findByText('Doctor');
    // Add a custom role to delete, then have the server refuse it.
    await userEvent.click(screen.getByRole('button', { name: 'Add role' }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), 'Ward clerk');
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await screen.findByText('Added Ward clerk.');

    const row = screen.getByRole('row', { name: /^Ward clerk/ });
    await userEvent.click(within(row).getByRole('button', { name: /^Delete/ }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete role' }));

    expect(
      await screen.findByText('You cannot change a role that may do more than yours.'),
    ).toBeInTheDocument();
  });
});
